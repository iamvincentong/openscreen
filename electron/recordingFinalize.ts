import { Buffer } from "node:buffer";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_INFO = 0x1549a966;
const EBML_ID_DURATION = 0x4489;

const HEADER_READ_BYTES = 256 * 1024;

interface Vint {
	value: number;
	width: number;
}

interface Element {
	idStart: number;
	idWidth: number;
	id: number;
	size: Vint;
	dataStart: number;
	dataEnd: number;
	unknownSize: boolean;
}

function readVint(buf: Buffer, offset: number): Vint {
	const first = buf[offset];
	if (first === 0) {
		throw new Error(`Invalid VINT at offset ${offset}`);
	}
	let mask = 0x80;
	let width = 1;
	while ((first & mask) === 0 && width < 8) {
		mask >>= 1;
		width++;
	}
	if (width > 8) {
		throw new Error(`VINT too wide at offset ${offset}`);
	}
	let value = first & (mask - 1);
	for (let i = 1; i < width; i++) {
		value = value * 256 + buf[offset + i];
	}
	return { value, width };
}

function readElementId(buf: Buffer, offset: number): Vint {
	const first = buf[offset];
	if (first === 0) {
		throw new Error(`Invalid element ID at offset ${offset}`);
	}
	let mask = 0x80;
	let width = 1;
	while ((first & mask) === 0 && width < 4) {
		mask >>= 1;
		width++;
	}
	let id = 0;
	for (let i = 0; i < width; i++) {
		id = id * 256 + buf[offset + i];
	}
	return { value: id, width };
}

function isUnknownSize(vint: Vint): boolean {
	const max = 2 ** (7 * vint.width) - 1;
	return vint.value === max;
}

function readElement(buf: Buffer, offset: number, parentEnd: number): Element {
	const id = readElementId(buf, offset);
	const size = readVint(buf, offset + id.width);
	const dataStart = offset + id.width + size.width;
	const unknown = isUnknownSize(size);
	const dataEnd = unknown ? parentEnd : dataStart + size.value;
	return {
		idStart: offset,
		idWidth: id.width,
		id: id.value,
		size,
		dataStart,
		dataEnd,
		unknownSize: unknown,
	};
}

function findChild(buf: Buffer, start: number, end: number, targetId: number): Element | null {
	let pos = start;
	while (pos + 2 <= end) {
		let el: Element;
		try {
			el = readElement(buf, pos, end);
		} catch {
			return null;
		}
		if (el.id === targetId) return el;
		if (el.dataEnd <= pos) return null;
		pos = el.dataEnd;
	}
	return null;
}

function encodeFloat64BE(value: number): Buffer {
	const buf = Buffer.alloc(8);
	buf.writeDoubleBE(value, 0);
	return buf;
}

function encodeVintSize(value: number, fixedWidth: number): Buffer | null {
	const maxAtWidth = 2 ** (7 * fixedWidth) - 2;
	if (value > maxAtWidth) return null;
	const buf = Buffer.alloc(fixedWidth);
	let remaining = value;
	for (let i = fixedWidth - 1; i >= 0; i--) {
		buf[i] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}
	buf[0] |= 1 << (8 - fixedWidth);
	return buf;
}

async function spliceInsert(
	srcPath: string,
	dstPath: string,
	patches: Array<{ offset: number; replaceLength: number; data: Buffer }>,
	insertions: Array<{ offset: number; data: Buffer }>,
): Promise<void> {
	const sortedPatches = [...patches].sort((a, b) => a.offset - b.offset);
	const sortedInsertions = [...insertions].sort((a, b) => a.offset - b.offset);
	const writer = createWriteStream(dstPath);
	let cursor = 0;

	const writeChunkRange = async (from: number, to: number) => {
		if (to <= from) return;
		await pipeline(createReadStream(srcPath, { start: from, end: to - 1 }), writer, {
			end: false,
		});
	};

	const writeBuffer = (data: Buffer) =>
		new Promise<void>((resolve, reject) => {
			writer.write(data, (err) => (err ? reject(err) : resolve()));
		});

	const events: Array<
		| { type: "patch"; offset: number; replaceLength: number; data: Buffer }
		| { type: "insert"; offset: number; data: Buffer }
	> = [];
	for (const p of sortedPatches) {
		events.push({ type: "patch", offset: p.offset, replaceLength: p.replaceLength, data: p.data });
	}
	for (const ins of sortedInsertions) {
		events.push({ type: "insert", offset: ins.offset, data: ins.data });
	}
	events.sort((a, b) => a.offset - b.offset);

	try {
		for (const ev of events) {
			if (ev.offset < cursor) {
				throw new Error(`Overlapping splice events at offset ${ev.offset} (cursor ${cursor})`);
			}
			await writeChunkRange(cursor, ev.offset);
			await writeBuffer(ev.data);
			cursor = ev.type === "patch" ? ev.offset + ev.replaceLength : ev.offset;
		}
		const stat = await fs.stat(srcPath);
		await writeChunkRange(cursor, stat.size);
		await new Promise<void>((resolve, reject) => {
			writer.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
		});
	} catch (error) {
		writer.destroy();
		throw error;
	}
}

/**
 * Patches the WebM file's Duration metadata in-place when possible, or via a
 * streaming temp-file splice when the Duration element must be inserted. Memory
 * usage is bounded to the header window (256 KiB) regardless of file size, so
 * arbitrarily long recordings can be finalized without loading them into RAM.
 */
export async function patchWebmDuration(
	filePath: string,
	durationMs: number,
): Promise<{ patched: boolean; reason?: string }> {
	if (!Number.isFinite(durationMs) || durationMs <= 0) {
		return { patched: false, reason: "non-positive duration" };
	}

	const fd = await fs.open(filePath, "r+");
	let header: Buffer;
	let fileSize: number;
	try {
		const stat = await fd.stat();
		fileSize = stat.size;
		const headerLen = Math.min(HEADER_READ_BYTES, fileSize);
		header = Buffer.alloc(headerLen);
		await fd.read(header, 0, headerLen, 0);

		let segment: Element | null = null;
		let pos = 0;
		while (pos < header.length) {
			let el: Element;
			try {
				el = readElement(header, pos, header.length);
			} catch {
				break;
			}
			if (el.id === EBML_ID_SEGMENT) {
				segment = el;
				break;
			}
			if (el.dataEnd <= pos) break;
			pos = el.dataEnd;
		}

		if (!segment) {
			return { patched: false, reason: "Segment element not found" };
		}

		const segmentSearchEnd = Math.min(segment.dataEnd, header.length);
		const info = findChild(header, segment.dataStart, segmentSearchEnd, EBML_ID_INFO);
		if (!info) {
			return { patched: false, reason: "Info element not found" };
		}
		if (info.unknownSize) {
			return { patched: false, reason: "Info has unknown size" };
		}

		const duration = findChild(header, info.dataStart, info.dataEnd, EBML_ID_DURATION);
		if (duration) {
			if (duration.size.value !== 8 && duration.size.value !== 4) {
				return { patched: false, reason: `unexpected Duration size ${duration.size.value}` };
			}
			if (duration.size.value === 8) {
				await fd.write(encodeFloat64BE(durationMs), 0, 8, duration.dataStart);
			} else {
				const f32 = Buffer.alloc(4);
				f32.writeFloatBE(durationMs, 0);
				await fd.write(f32, 0, 4, duration.dataStart);
			}
			return { patched: true };
		}

		const insertion = Buffer.concat([Buffer.from([0x44, 0x89, 0x88]), encodeFloat64BE(durationMs)]);
		const newInfoDataSize = info.dataEnd - info.dataStart + insertion.length;
		const newInfoSizeBytes = encodeVintSize(newInfoDataSize, info.size.width);
		if (!newInfoSizeBytes) {
			return { patched: false, reason: "Info size VINT cannot fit at original width" };
		}

		const sizeFieldOffset = info.idStart + info.idWidth;
		const insertionOffset = info.dataEnd;

		await fd.close();
		const tmpPath = `${filePath}.duration.tmp`;
		try {
			await spliceInsert(
				filePath,
				tmpPath,
				[{ offset: sizeFieldOffset, replaceLength: info.size.width, data: newInfoSizeBytes }],
				[{ offset: insertionOffset, data: insertion }],
			);
			await fs.rename(tmpPath, filePath);
		} catch (error) {
			await fs.unlink(tmpPath).catch(() => undefined);
			throw error;
		}
		return { patched: true };
	} finally {
		try {
			await fd.close();
		} catch {
			// Already closed in the splice branch.
		}
	}
}

// ─── WebM segment stitching ──────────────────────────────────────────────────

const CLUSTER_ELEMENT_ID = 0x1f43b675;
const TIMECODE_ELEMENT_ID = 0xe7;

/**
 * Returns the byte offset of the first Cluster element in a WebM header buffer,
 * or -1 if not found. Used to skip EBML/Segment/Info/Tracks when appending.
 */
function findClustersStartOffset(headerBuf: Buffer): number {
	let pos = 0;
	while (pos + 2 <= headerBuf.length) {
		let el: Element;
		try {
			el = readElement(headerBuf, pos, headerBuf.length);
		} catch {
			return -1;
		}
		if (el.id === EBML_ID_SEGMENT) {
			let spos = el.dataStart;
			const send = el.unknownSize ? headerBuf.length : Math.min(el.dataEnd, headerBuf.length);
			while (spos + 2 <= send) {
				let child: Element;
				try {
					child = readElement(headerBuf, spos, send);
				} catch {
					return -1;
				}
				if (child.id === CLUSTER_ELEMENT_ID) return child.idStart;
				if (child.unknownSize || child.dataEnd <= spos) return -1;
				spos = child.dataEnd;
			}
			return -1;
		}
		if (el.unknownSize || el.dataEnd <= pos) return -1;
		pos = el.dataEnd;
	}
	return -1;
}

type PatchPhase = "scan" | "clsz" | "tcid" | "tcsz" | "tcval" | "fwd";

/**
 * Transform stream that adjusts Cluster Timecode elements in a WebM byte stream
 * by adding a fixed millisecond offset. Input must begin at the first Cluster.
 *
 * Assumes live-mode WebM (unknown-size clusters, as produced by Chromium MediaRecorder).
 * Cluster ID pattern scanning is used to locate boundaries; false positives on video
 * data are theoretically possible but negligible in practice for screen recordings.
 */
class WebmClusterTimecodeOffset extends Transform {
	private readonly offsetMs: number;
	private carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private phase: PatchPhase = "scan";
	private tcExpected = 0;
	private tcAcc: number[] = [];

	constructor(offsetMs: number) {
		super();
		this.offsetMs = offsetMs;
	}

	_transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
		this.carry = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
		this._drain(false);
		cb();
	}

	_flush(cb: TransformCallback): void {
		this._drain(true);
		if (this.carry.length > 0) {
			this.push(this.carry);
			this.carry = Buffer.alloc(0);
		}
		cb();
	}

	private _drain(final: boolean): void {
		let progressed = true;
		while (progressed) {
			const before = this.carry.length;
			this._step(final);
			progressed = this.carry.length < before;
		}
	}

	private _findCluster(): number {
		for (let i = 0; i <= this.carry.length - 4; i++) {
			if (
				this.carry[i] === 0x1f &&
				this.carry[i + 1] === 0x43 &&
				this.carry[i + 2] === 0xb6 &&
				this.carry[i + 3] === 0x75
			)
				return i;
		}
		return -1;
	}

	private _readVint(): { value: number; width: number } | null {
		if (this.carry.length === 0) return null;
		const first = this.carry[0];
		if (first === 0) return null;
		let mask = 0x80;
		let width = 1;
		while ((first & mask) === 0 && width < 8) {
			mask >>= 1;
			width++;
		}
		if (this.carry.length < width) return null;
		let value = first & (mask - 1);
		for (let i = 1; i < width; i++) value = value * 256 + this.carry[i];
		const unknown = value === 2 ** (7 * width) - 1;
		return { value: unknown ? -1 : value, width };
	}

	private _step(final: boolean): void {
		switch (this.phase) {
			case "scan": {
				const idx = this._findCluster();
				if (idx < 0) {
					const keep = final ? 0 : 3;
					const n = this.carry.length - keep;
					if (n > 0) {
						this.push(this.carry.slice(0, n));
						this.carry = this.carry.slice(n);
					}
					return;
				}
				this.push(this.carry.slice(0, idx + 4));
				this.carry = this.carry.slice(idx + 4);
				this.phase = "clsz";
				break;
			}
			case "clsz": {
				const vint = this._readVint();
				if (!vint) return;
				this.push(this.carry.slice(0, vint.width));
				this.carry = this.carry.slice(vint.width);
				this.phase = "tcid";
				break;
			}
			case "tcid": {
				if (this.carry.length === 0) return;
				const b = this.carry[0];
				this.carry = this.carry.slice(1);
				if (b === TIMECODE_ELEMENT_ID) {
					this.tcAcc = [];
					this.phase = "tcsz";
				} else {
					this.push(Buffer.from([b]));
					this.phase = "fwd";
				}
				break;
			}
			case "tcsz": {
				const vint = this._readVint();
				if (!vint) return;
				this.tcExpected = vint.value < 0 ? 0 : vint.value;
				this.carry = this.carry.slice(vint.width);
				this.phase = "tcval";
				break;
			}
			case "tcval": {
				const need = this.tcExpected - this.tcAcc.length;
				if (this.carry.length < need) {
					for (const b of this.carry) this.tcAcc.push(b);
					this.carry = Buffer.alloc(0);
					return;
				}
				for (let i = 0; i < need; i++) this.tcAcc.push(this.carry[i]);
				this.carry = this.carry.slice(need);

				let orig = 0;
				for (const b of this.tcAcc) orig = orig * 256 + b;
				const patched = orig + this.offsetMs;

				// Encode with at least as many bytes as original (avoids shrinking known-size clusters)
				const minBytes = patched > 0xffffff ? 4 : patched > 0xffff ? 3 : patched > 0xff ? 2 : 1;
				const bytes = Math.max(minBytes, this.tcExpected, 1);
				const el = Buffer.alloc(2 + bytes);
				el[0] = TIMECODE_ELEMENT_ID;
				el[1] = 0x80 | bytes; // 1-byte VINT encoding for size ≤ 127
				let tmp = patched;
				for (let i = bytes - 1; i >= 0; i--) {
					el[2 + i] = tmp & 0xff;
					tmp = Math.floor(tmp / 256);
				}
				this.push(el);
				this.phase = "fwd";
				break;
			}
			case "fwd": {
				const idx = this._findCluster();
				if (idx < 0) {
					const keep = final ? 0 : 3;
					const n = this.carry.length - keep;
					if (n > 0) {
						this.push(this.carry.slice(0, n));
						this.carry = this.carry.slice(n);
					}
					return;
				}
				if (idx > 0) {
					this.push(this.carry.slice(0, idx));
					this.carry = this.carry.slice(idx);
				}
				this.phase = "scan";
				break;
			}
		}
	}
}

function appendClustersToStream(
	srcPath: string,
	clustersStart: number,
	offsetMs: number,
	dest: WriteStream,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const src = createReadStream(srcPath, { start: clustersStart });
		const patcher = new WebmClusterTimecodeOffset(offsetMs);

		let settled = false;
		const done = (err?: Error) => {
			if (settled) return;
			settled = true;
			src.destroy();
			if (err) reject(err);
			else resolve();
		};

		src.on("error", done);
		patcher.on("error", done);
		patcher.on("finish", () => done());
		src.pipe(patcher);
		patcher.pipe(dest, { end: false });
	});
}

/**
 * Appends clusters from additional WebM segment files onto basePath,
 * adjusting each segment's cluster timecodes by its given offset.
 * basePath is modified in place (opened for appending).
 * Does NOT patch the duration header — call patchWebmDuration separately.
 */
export async function stitchWebmSegments(
	basePath: string,
	additionalPaths: string[],
	offsetsMs: number[],
): Promise<void> {
	if (additionalPaths.length === 0) return;

	const dest = createWriteStream(basePath, { flags: "a" });
	await new Promise<void>((res, rej) => {
		dest.once("open", res);
		dest.once("error", rej);
	});

	try {
		for (let i = 0; i < additionalPaths.length; i++) {
			const srcPath = additionalPaths[i];
			const offsetMs = offsetsMs[i] ?? 0;

			const stat = await fs.stat(srcPath).catch(() => null);
			if (!stat || stat.size === 0) continue;

			const headerLen = Math.min(HEADER_READ_BYTES, stat.size);
			const headerBuf = Buffer.alloc(headerLen);
			const fd = await fs.open(srcPath, "r");
			try {
				await fd.read(headerBuf, 0, headerLen, 0);
			} finally {
				await fd.close();
			}

			const clustersStart = findClustersStartOffset(headerBuf);
			if (clustersStart < 0) {
				console.warn(`[stitch] No clusters found in ${path.basename(srcPath)}, skipping`);
				continue;
			}

			await appendClustersToStream(srcPath, clustersStart, offsetMs, dest);
		}
	} finally {
		await new Promise<void>((res, rej) => {
			dest.end((err: Error | null | undefined) => (err ? rej(err) : res()));
		});
	}
}

export function isPathInsideDirectory(target: string, dir: string): boolean {
	const resolvedTarget = path.resolve(target);
	const resolvedDir = path.resolve(dir);
	return resolvedTarget === resolvedDir || resolvedTarget.startsWith(resolvedDir + path.sep);
}
