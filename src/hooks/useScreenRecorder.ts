import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { requestCameraAccess } from "@/lib/requestCameraAccess";

const TARGET_FRAME_RATE = 60;
const MIN_FRAME_RATE = 30;
const TARGET_WIDTH = 3840;
const TARGET_HEIGHT = 2160;
const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
const QHD_WIDTH = 2560;
const QHD_HEIGHT = 1440;
const QHD_PIXELS = QHD_WIDTH * QHD_HEIGHT;

const BITRATE_4K = 45_000_000;
const BITRATE_QHD = 28_000_000;
const BITRATE_BASE = 18_000_000;
const HIGH_FRAME_RATE_THRESHOLD = 60;
const HIGH_FRAME_RATE_BOOST = 1.7;

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

const CODEC_ALIGNMENT = 2;

const RECORDER_TIMESLICE_MS = 1000;
const BITS_PER_MEGABIT = 1_000_000;
const CHROME_MEDIA_SOURCE = "desktop";
const RECORDING_FILE_PREFIX = "recording-";
const VIDEO_FILE_EXTENSION = ".webm";
const WEBCAM_FILE_SUFFIX = "-webcam";

const AUDIO_BITRATE_VOICE = 128_000;
const AUDIO_BITRATE_SYSTEM = 192_000;

const MIC_GAIN_BOOST = 1.4;
const WEBCAM_TARGET_WIDTH = 1280;
const WEBCAM_TARGET_HEIGHT = 720;
const WEBCAM_TARGET_FRAME_RATE = 30;

const SEGMENT_ROTATION_MS = 60 * 60 * 1000;

type UseScreenRecorderReturn = {
	recording: boolean;
	paused: boolean;
	elapsedSeconds: number;
	toggleRecording: () => void;
	togglePaused: () => void;
	restartRecording: () => void;
	cancelRecording: () => void;
	microphoneEnabled: boolean;
	setMicrophoneEnabled: (enabled: boolean) => void;
	microphoneDeviceId: string | undefined;
	setMicrophoneDeviceId: (deviceId: string | undefined) => void;
	webcamDeviceId: string | undefined;
	setWebcamDeviceId: (deviceId: string | undefined) => void;
	systemAudioEnabled: boolean;
	setSystemAudioEnabled: (enabled: boolean) => void;
	webcamEnabled: boolean;
	setWebcamEnabled: (enabled: boolean) => Promise<boolean>;
};

type RecorderHandle = {
	recorder: MediaRecorder;
	recordedFilePromise: Promise<string>;
	filePath: string;
	token: number;
};

const logRecorderDiag = (filePath: string, event: Record<string, unknown>): void => {
	void window.electronAPI.recordingStreamDiag(filePath, event).catch(() => undefined);
};

async function createRecorderHandle(
	stream: MediaStream,
	options: MediaRecorderOptions,
	fileName: string,
): Promise<RecorderHandle> {
	const openResult = await window.electronAPI.recordingStreamOpen(fileName);
	if (!openResult.success || openResult.token === undefined || !openResult.filePath) {
		throw new Error(openResult.error || "Failed to open recording stream");
	}
	const token = openResult.token;
	const filePath = openResult.filePath;

	const recorder = new MediaRecorder(stream, options);

	let writeChain: Promise<void> = Promise.resolve();
	let appendFailureSeen = false;

	const stopRecorderSafely = () => {
		try {
			if (recorder.state !== "inactive") {
				recorder.stop();
			}
		} catch {
			// Recorder may already be stopping.
		}
	};

	const recordedFilePromise = new Promise<string>((resolve, reject) => {
		recorder.ondataavailable = (event: BlobEvent) => {
			if (!event.data || event.data.size === 0) return;
			const dataPromise = event.data.arrayBuffer();
			writeChain = writeChain
				.then(async () => {
					const buf = await dataPromise;
					const result = await window.electronAPI.recordingStreamAppend(token, buf);
					if (!result?.success) {
						throw new Error(result?.error || "Recording append failed");
					}
				})
				.catch((err) => {
					if (!appendFailureSeen) {
						appendFailureSeen = true;
						console.warn("Recording chunk write failed; finalizing what's on disk:", err);
						logRecorderDiag(filePath, {
							tag: "append.fail",
							error: err instanceof Error ? err.message : String(err),
							recorderState: recorder.state,
						});
						stopRecorderSafely();
					}
				});
		};
		recorder.onerror = (event) => {
			console.warn("MediaRecorder error; finalizing what's on disk:", event);
			const evtError = (event as Event & { error?: { name?: string; message?: string } }).error;
			logRecorderDiag(filePath, {
				tag: "recorder.error",
				errorName: evtError?.name ?? null,
				errorMessage: evtError?.message ?? null,
				recorderState: recorder.state,
			});
			stopRecorderSafely();
		};
		recorder.onstop = () => {
			logRecorderDiag(filePath, { tag: "recorder.stop", recorderState: recorder.state });
			writeChain
				.then(async () => {
					const closeResult = await window.electronAPI.recordingStreamClose(token);
					if (!closeResult?.success || !closeResult.filePath) {
						throw new Error(closeResult?.error || "Failed to close recording stream");
					}
					return closeResult.filePath;
				})
				.then(resolve, reject);
		};
	});

	recorder.start(RECORDER_TIMESLICE_MS);
	const startVideoTrack = stream.getVideoTracks()[0];
	const startVideoSettings = startVideoTrack?.getSettings() ?? {};
	logRecorderDiag(filePath, {
		tag: "recorder.start",
		mimeType: options.mimeType ?? null,
		videoBitsPerSecond: options.videoBitsPerSecond ?? null,
		audioBitsPerSecond: options.audioBitsPerSecond ?? null,
		timesliceMs: RECORDER_TIMESLICE_MS,
		width: startVideoSettings.width ?? null,
		height: startVideoSettings.height ?? null,
		frameRate: startVideoSettings.frameRate ?? null,
		audioTrackCount: stream.getAudioTracks().length,
	});
	return { recorder, recordedFilePromise, filePath, token };
}

export function useScreenRecorder(): UseScreenRecorderReturn {
	const t = useScopedT("editor");
	const [recording, setRecording] = useState(false);
	const [paused, setPaused] = useState(false);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [microphoneDeviceId, setMicrophoneDeviceId] = useState<string | undefined>(undefined);
	const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>(undefined);
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
	const [webcamEnabled, setWebcamEnabledState] = useState(false);
	const screenRecorder = useRef<RecorderHandle | null>(null);
	const webcamRecorder = useRef<RecorderHandle | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const screenStream = useRef<MediaStream | null>(null);
	const microphoneStream = useRef<MediaStream | null>(null);
	const webcamStream = useRef<MediaStream | null>(null);
	const mixingContext = useRef<AudioContext | null>(null);
	const recordingId = useRef<number>(0);
	const accumulatedDurationMs = useRef(0);
	const segmentStartedAt = useRef<number | null>(null);
	const finalizingRecordingId = useRef<number | null>(null);
	const allowAutoFinalize = useRef(false);
	const discardRecordingId = useRef<number | null>(null);
	const restarting = useRef(false);
	const countdownRunId = useRef(0);
	const [countdownActive, setCountdownActive] = useState(false);
	const webcamReady = useRef(false);
	const webcamAcquireId = useRef(0);
	const segmentHistory = useRef<
		Array<{ screenFilePath: string; webcamFilePath: string | null; cumulativeDurationMs: number }>
	>([]);
	const segmentRotationTimer = useRef<number | null>(null);
	const rotating = useRef(false);
	const recorderOptions = useRef<{
		mimeType: string;
		videoBitsPerSecond: number;
		audioBitsPerSecond?: number;
	} | null>(null);

	const getRecordingDurationMs = useCallback(() => {
		const segmentDuration =
			segmentStartedAt.current === null ? 0 : Date.now() - segmentStartedAt.current;
		return accumulatedDurationMs.current + segmentDuration;
	}, []);

	const selectMimeType = () => {
		const preferred = [
			"video/webm;codecs=vp9",
			"video/webm;codecs=h264",
			"video/webm;codecs=vp8",
			"video/webm",
		];

		return preferred.find((type) => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
	};

	const computeBitrate = (width: number, height: number) => {
		const pixels = width * height;
		const highFrameRateBoost =
			TARGET_FRAME_RATE >= HIGH_FRAME_RATE_THRESHOLD ? HIGH_FRAME_RATE_BOOST : 1;

		if (pixels >= FOUR_K_PIXELS) {
			return Math.round(BITRATE_4K * highFrameRateBoost);
		}

		if (pixels >= QHD_PIXELS) {
			return Math.round(BITRATE_QHD * highFrameRateBoost);
		}

		return Math.round(BITRATE_BASE * highFrameRateBoost);
	};

	const teardownMedia = useCallback(() => {
		if (stream.current) {
			stream.current.getTracks().forEach((track) => track.stop());
			stream.current = null;
		}
		if (screenStream.current) {
			screenStream.current.getTracks().forEach((track) => track.stop());
			screenStream.current = null;
		}
		if (microphoneStream.current) {
			microphoneStream.current.getTracks().forEach((track) => track.stop());
			microphoneStream.current = null;
		}
		if (mixingContext.current) {
			mixingContext.current.close().catch(() => {
				// Ignore close errors during recorder teardown.
			});
			mixingContext.current = null;
		}
	}, []);

	const setWebcamEnabled = useCallback(
		async (enabled: boolean) => {
			if (!enabled) {
				setWebcamEnabledState(false);
				return true;
			}

			const accessResult = await requestCameraAccess();
			if (!accessResult.success) {
				toast.error(t("recording.failedCameraAccess"));
				return false;
			}

			if (!accessResult.granted) {
				toast.error(t("recording.cameraBlocked"));
				return false;
			}

			setWebcamEnabledState(true);
			return true;
		},
		[t],
	);

	useEffect(() => {
		if (!webcamEnabled) return;

		let cancelled = false;
		let acquiredStream: MediaStream | null = null;
		const thisAcquireId = ++webcamAcquireId.current;
		webcamReady.current = false;

		const acquire = async () => {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: webcamDeviceId
						? {
								deviceId: { exact: webcamDeviceId },
								width: { ideal: WEBCAM_TARGET_WIDTH },
								height: { ideal: WEBCAM_TARGET_HEIGHT },
								frameRate: { ideal: WEBCAM_TARGET_FRAME_RATE, max: WEBCAM_TARGET_FRAME_RATE },
							}
						: {
								width: { ideal: WEBCAM_TARGET_WIDTH },
								height: { ideal: WEBCAM_TARGET_HEIGHT },
								frameRate: { ideal: WEBCAM_TARGET_FRAME_RATE, max: WEBCAM_TARGET_FRAME_RATE },
							},
				});

				if (cancelled || thisAcquireId !== webcamAcquireId.current) {
					stream.getTracks().forEach((track) => {
						track.onended = null;
						track.stop();
					});
					return;
				}

				acquiredStream = stream;
				stream.getVideoTracks().forEach((track) => {
					track.onended = () => {
						webcamStream.current = null;
						if (!restarting.current) {
							setWebcamEnabledState(false);
							toast.error(t("recording.cameraDisconnected"));
						}
					};
				});
				webcamStream.current = stream;
				webcamReady.current = true;
			} catch (cameraError) {
				if (!cancelled) {
					console.warn("Failed to get webcam access:", cameraError);
					setWebcamEnabledState(false);
					const isDeviceError =
						cameraError instanceof DOMException &&
						[
							"NotFoundError",
							"DevicesNotFoundError",
							"OverconstrainedError",
							"NotReadableError",
						].includes(cameraError.name);
					toast.error(t(isDeviceError ? "recording.cameraNotFound" : "recording.cameraBlocked"));
					webcamReady.current = true;
				}
			}
		};

		void acquire();

		return () => {
			cancelled = true;
			webcamReady.current = false;
			if (acquiredStream) {
				acquiredStream.getTracks().forEach((track) => {
					track.onended = null;
					track.stop();
				});
				webcamStream.current = null;
			}
		};
	}, [webcamEnabled, webcamDeviceId, t]);

	const finalizeRecording = useCallback(
		(
			activeScreenRecorder: RecorderHandle,
			activeWebcamRecorder: RecorderHandle | null,
			duration: number,
			activeRecordingId: number,
		) => {
			if (finalizingRecordingId.current === activeRecordingId) {
				return;
			}
			finalizingRecordingId.current = activeRecordingId;

			// Capture segment history synchronously before any async work
			const capturedSegments = segmentHistory.current.slice();
			segmentHistory.current = [];
			if (segmentRotationTimer.current !== null) {
				window.clearTimeout(segmentRotationTimer.current);
				segmentRotationTimer.current = null;
			}

			if (screenRecorder.current === activeScreenRecorder) {
				screenRecorder.current = null;
			}
			if (activeWebcamRecorder && webcamRecorder.current === activeWebcamRecorder) {
				webcamRecorder.current = null;
			}

			teardownMedia();
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
			window.electronAPI?.setRecordingState(false);

			void (async () => {
				try {
					const screenFilePath = await activeScreenRecorder.recordedFilePromise;
					const webcamFilePath = activeWebcamRecorder
						? await activeWebcamRecorder.recordedFilePromise.catch(() => null)
						: null;

					if (discardRecordingId.current === activeRecordingId) {
						for (const seg of capturedSegments) {
							await window.electronAPI
								.recordingStreamDiscard(seg.screenFilePath)
								.catch(() => undefined);
							if (seg.webcamFilePath) {
								await window.electronAPI
									.recordingStreamDiscard(seg.webcamFilePath)
									.catch(() => undefined);
							}
						}
						await window.electronAPI.recordingStreamDiscard(screenFilePath).catch(() => undefined);
						if (webcamFilePath) {
							await window.electronAPI
								.recordingStreamDiscard(webcamFilePath)
								.catch(() => undefined);
						}
						return;
					}

					const screenFileName = `${RECORDING_FILE_PREFIX}${activeRecordingId}${VIDEO_FILE_EXTENSION}`;
					const webcamFileName = `${RECORDING_FILE_PREFIX}${activeRecordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`;

					const allScreenPaths = [...capturedSegments.map((s) => s.screenFilePath), screenFilePath];
					const allWebcamPaths = [...capturedSegments.map((s) => s.webcamFilePath), webcamFilePath];
					const hasWebcam = allWebcamPaths.some((p) => p !== null);
					const segmentOffsets = [0, ...capturedSegments.map((s) => s.cumulativeDurationMs)];

					const result = await window.electronAPI.recordingStreamFinalize({
						screen: { filePaths: allScreenPaths, fileName: screenFileName },
						webcam: hasWebcam
							? {
									filePaths: allWebcamPaths.map((p, i) => p ?? allScreenPaths[i]),
									fileName: webcamFileName,
								}
							: undefined,
						durationMs: duration,
						segmentOffsets,
						createdAt: activeRecordingId,
					});

					if (!result.success) {
						console.error("Failed to finalize recording session:", result.message);
						return;
					}

					if (result.session) {
						await window.electronAPI.setCurrentRecordingSession(result.session);
					} else if (result.path) {
						await window.electronAPI.setCurrentVideoPath(result.path);
					}

					await window.electronAPI.switchToEditor();
				} catch (error) {
					console.error("Error saving recording:", error);
				} finally {
					if (finalizingRecordingId.current === activeRecordingId) {
						finalizingRecordingId.current = null;
					}
					if (discardRecordingId.current === activeRecordingId) {
						discardRecordingId.current = null;
					}
				}
			})();
		},
		[teardownMedia],
	);

	const stopRecording = useRef(() => {
		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder) {
			return;
		}

		const activeWebcamRecorder = webcamRecorder.current;
		const duration = getRecordingDurationMs();
		const activeRecordingId = recordingId.current;

		finalizeRecording(
			activeScreenRecorder,
			activeWebcamRecorder ?? null,
			duration,
			activeRecordingId,
		);

		if (
			activeScreenRecorder.recorder.state === "recording" ||
			activeScreenRecorder.recorder.state === "paused"
		) {
			try {
				activeScreenRecorder.recorder.stop();
			} catch {
				// Recorder may already be stopping.
			}
		}
		if (activeWebcamRecorder) {
			if (
				activeWebcamRecorder.recorder.state === "recording" ||
				activeWebcamRecorder.recorder.state === "paused"
			) {
				try {
					activeWebcamRecorder.recorder.stop();
				} catch {
					// Recorder may already be stopping.
				}
			}
		}
	});

	const doRotate = useRef(async () => {
		if (rotating.current || restarting.current) return;
		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder || activeScreenRecorder.recorder.state === "inactive") return;
		if (!stream.current) return;

		rotating.current = true;
		allowAutoFinalize.current = false;

		try {
			const cumulativeDurationMs = getRecordingDurationMs();
			const activeWebcamRecorder = webcamRecorder.current;

			try {
				activeScreenRecorder.recorder.stop();
			} catch {
				/* already stopping */
			}
			if (activeWebcamRecorder) {
				try {
					activeWebcamRecorder.recorder.stop();
				} catch {
					/* already stopping */
				}
			}

			const [screenFilePath, webcamFilePath] = await Promise.all([
				activeScreenRecorder.recordedFilePromise.catch(() => null),
				activeWebcamRecorder
					? activeWebcamRecorder.recordedFilePromise.catch(() => null)
					: Promise.resolve(null),
			]);

			if (!screenFilePath) {
				console.warn("Segment rotation: screen write failed, stopping recording");
				allowAutoFinalize.current = true;
				rotating.current = false;
				finalizeRecording(
					activeScreenRecorder,
					activeWebcamRecorder ?? null,
					cumulativeDurationMs,
					recordingId.current,
				);
				return;
			}

			segmentHistory.current.push({
				screenFilePath,
				webcamFilePath: webcamFilePath ?? null,
				cumulativeDurationMs,
			});
			accumulatedDurationMs.current = cumulativeDurationMs;
			segmentStartedAt.current = Date.now();

			const n = segmentHistory.current.length + 1;
			const pad = String(n).padStart(3, "0");
			const newScreenFileName = `${RECORDING_FILE_PREFIX}${recordingId.current}-s${pad}${VIDEO_FILE_EXTENSION}`;
			const newWebcamFileName = `${RECORDING_FILE_PREFIX}${recordingId.current}-s${pad}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`;

			const opts = recorderOptions.current;
			if (!opts || !stream.current) {
				allowAutoFinalize.current = true;
				rotating.current = false;
				return;
			}

			let newScreenHandle: RecorderHandle;
			try {
				newScreenHandle = await createRecorderHandle(stream.current, opts, newScreenFileName);
			} catch (err) {
				console.error("Segment rotation: failed to open new screen handle", err);
				allowAutoFinalize.current = true;
				rotating.current = false;
				return;
			}

			let newWebcamHandle: RecorderHandle | null = null;
			if (webcamStream.current && activeWebcamRecorder) {
				try {
					newWebcamHandle = await createRecorderHandle(
						webcamStream.current,
						{
							mimeType: opts.mimeType,
							videoBitsPerSecond: Math.min(opts.videoBitsPerSecond, BITRATE_BASE),
						},
						newWebcamFileName,
					);
				} catch {
					/* webcam segment failed; continue without webcam */
				}
			}

			screenRecorder.current = newScreenHandle;
			webcamRecorder.current = newWebcamHandle;

			newScreenHandle.recorder.addEventListener(
				"error",
				() => {
					setRecording(false);
				},
				{ once: true },
			);

			const capturedRecordingId = recordingId.current;
			newScreenHandle.recorder.addEventListener(
				"stop",
				() => {
					if (!allowAutoFinalize.current) return;
					finalizeRecording(
						newScreenHandle,
						newWebcamHandle,
						Math.max(0, getRecordingDurationMs()),
						capturedRecordingId,
					);
				},
				{ once: true },
			);

			logRecorderDiag(newScreenHandle.filePath, {
				tag: "segment.rotated",
				segmentN: n,
				cumulativeDurationMs,
			});

			allowAutoFinalize.current = true;
			segmentRotationTimer.current = window.setTimeout(
				() => void doRotate.current(),
				SEGMENT_ROTATION_MS,
			);
		} catch (err) {
			console.error("Segment rotation failed:", err);
			allowAutoFinalize.current = true;
		} finally {
			rotating.current = false;
		}
	});

	useEffect(() => {
		let cleanup: (() => void) | undefined;

		if (window.electronAPI?.onStopRecordingFromTray) {
			cleanup = window.electronAPI.onStopRecordingFromTray(() => {
				stopRecording.current();
			});
		}

		let cleanupDiskLow: (() => void) | undefined;
		if (window.electronAPI?.onStopRecordingDiskLow) {
			cleanupDiskLow = window.electronAPI.onStopRecordingDiskLow(() => {
				toast.warning("Disk space low — finalizing recording.");
				stopRecording.current();
			});
		}

		return () => {
			const activeRunId = countdownRunId.current;
			if (cleanup) cleanup();
			if (cleanupDiskLow) cleanupDiskLow();
			countdownRunId.current += 1;
			void safeHideCountdownOverlay(activeRunId);
			allowAutoFinalize.current = false;
			restarting.current = false;
			rotating.current = false;
			discardRecordingId.current = null;
			if (segmentRotationTimer.current !== null) {
				window.clearTimeout(segmentRotationTimer.current);
				segmentRotationTimer.current = null;
			}
			segmentHistory.current = [];

			const screenHandle = screenRecorder.current;
			const webcamHandle = webcamRecorder.current;

			if (
				screenHandle?.recorder.state === "recording" ||
				screenHandle?.recorder.state === "paused"
			) {
				try {
					screenHandle.recorder.stop();
				} catch {
					// Ignore recorder teardown errors during cleanup.
				}
			}
			if (
				webcamHandle?.recorder.state === "recording" ||
				webcamHandle?.recorder.state === "paused"
			) {
				try {
					webcamHandle.recorder.stop();
				} catch {
					// Ignore recorder teardown errors during cleanup.
				}
			}
			screenRecorder.current = null;
			webcamRecorder.current = null;
			teardownMedia();
		};
	}, [teardownMedia, safeHideCountdownOverlay]);

	const safeShowCountdownOverlay = async (value: number, runId: number) => {
		try {
			await window.electronAPI.showCountdownOverlay(value, runId);
			return true;
		} catch (error) {
			console.warn("Failed to show countdown overlay:", error);
			return false;
		}
	};

	const cancelCountdown = () => {
		const activeRunId = countdownRunId.current;
		countdownRunId.current += 1;
		setCountdownActive(false);
		void safeHideCountdownOverlay(activeRunId);
	};

	const safeSetCountdownOverlayValue = async (value: number, runId: number) => {
		try {
			await window.electronAPI.setCountdownOverlayValue(value, runId);
		} catch (error) {
			console.warn("Failed to update countdown overlay value:", error);
		}
	};

	const safeHideCountdownOverlay = async (runId: number) => {
		try {
			await window.electronAPI.hideCountdownOverlay(runId);
		} catch (error) {
			console.warn("Failed to hide countdown overlay:", error);
		}
	};

	const isCountdownRunActive = (runId?: number) =>
		runId === undefined || countdownRunId.current === runId;

	const startRecordCountdown = async () => {
		if (countdownActive || recording) {
			return;
		}

		const runId = countdownRunId.current + 1;
		countdownRunId.current = runId;
		setCountdownActive(true);

		let selectedSource: ProcessedDesktopSource | null = null;
		try {
			selectedSource = await window.electronAPI.getSelectedSource();
		} catch (error) {
			console.warn("Failed to read selected source before countdown:", error);
		}

		if (!isCountdownRunActive(runId)) {
			return;
		}

		if (!selectedSource) {
			if (countdownRunId.current === runId) {
				setCountdownActive(false);
			}
			alert(t("recording.selectSource"));
			return;
		}

		let overlayHiddenBeforeStart = false;
		try {
			const values = [3, 2, 1];
			const overlayShown = await safeShowCountdownOverlay(values[0], runId);

			if (countdownRunId.current !== runId) {
				return;
			}

			for (const value of values) {
				if (countdownRunId.current !== runId) {
					return;
				}

				if (overlayShown && value !== values[0]) {
					await safeSetCountdownOverlayValue(value, runId);

					if (countdownRunId.current !== runId) {
						return;
					}
				}

				await new Promise((resolve) => window.setTimeout(resolve, 1000));
			}

			if (countdownRunId.current !== runId) {
				return;
			}

			setCountdownActive(false);
			await safeHideCountdownOverlay(runId);
			overlayHiddenBeforeStart = true;

			if (countdownRunId.current !== runId) {
				return;
			}

			await startRecording(runId);
		} finally {
			if (!overlayHiddenBeforeStart && countdownRunId.current === runId) {
				setCountdownActive(false);
				await safeHideCountdownOverlay(runId);
			}
		}
	};

	const startRecording = async (countdownRunToken?: number) => {
		try {
			const selectedSource = await window.electronAPI.getSelectedSource();
			if (!selectedSource) {
				alert(t("recording.selectSource"));
				return;
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			let screenMediaStream: MediaStream;

			const videoConstraints = {
				mandatory: {
					chromeMediaSource: CHROME_MEDIA_SOURCE,
					chromeMediaSourceId: selectedSource.id,
					maxWidth: TARGET_WIDTH,
					maxHeight: TARGET_HEIGHT,
					maxFrameRate: TARGET_FRAME_RATE,
					minFrameRate: MIN_FRAME_RATE,
				},
			};

			if (systemAudioEnabled) {
				try {
					screenMediaStream = await navigator.mediaDevices.getUserMedia({
						audio: {
							mandatory: {
								chromeMediaSource: CHROME_MEDIA_SOURCE,
								chromeMediaSourceId: selectedSource.id,
							},
						},
						video: videoConstraints,
					} as unknown as MediaStreamConstraints);
				} catch (audioErr) {
					console.warn("System audio capture failed, falling back to video-only:", audioErr);
					toast.error(t("recording.systemAudioUnavailable"));
					screenMediaStream = await navigator.mediaDevices.getUserMedia({
						audio: false,
						video: videoConstraints,
					} as unknown as MediaStreamConstraints);
				}
			} else {
				screenMediaStream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: videoConstraints,
				} as unknown as MediaStreamConstraints);
			}
			screenStream.current = screenMediaStream;

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			if (microphoneEnabled) {
				try {
					microphoneStream.current = await navigator.mediaDevices.getUserMedia({
						audio: microphoneDeviceId
							? {
									deviceId: { exact: microphoneDeviceId },
									echoCancellation: true,
									noiseSuppression: true,
									autoGainControl: true,
								}
							: {
									echoCancellation: true,
									noiseSuppression: true,
									autoGainControl: true,
								},
						video: false,
					});
				} catch (audioError) {
					console.warn("Failed to get microphone access:", audioError);
					toast.error(t("recording.microphoneDenied"));
					setMicrophoneEnabled(false);
				}
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			if (webcamEnabled) {
				if (!webcamReady.current) {
					await new Promise<void>((resolve) => {
						const interval = setInterval(() => {
							if (webcamReady.current) {
								clearInterval(interval);
								resolve();
							}
						}, 50);
						setTimeout(() => {
							clearInterval(interval);
							resolve();
						}, 5000);
					});
				}
				if (!webcamStream.current) {
					webcamAcquireId.current++;
					setWebcamEnabledState(false);
				}
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			stream.current = new MediaStream();
			const videoTrack = screenMediaStream.getVideoTracks()[0];
			if (!videoTrack) {
				throw new Error("Video track is not available.");
			}
			stream.current.addTrack(videoTrack);

			const systemAudioTrack = screenMediaStream.getAudioTracks()[0];
			const micAudioTrack = microphoneStream.current?.getAudioTracks()[0];

			if (systemAudioTrack && micAudioTrack) {
				const ctx = new AudioContext();
				mixingContext.current = ctx;
				const systemSource = ctx.createMediaStreamSource(new MediaStream([systemAudioTrack]));
				const micSource = ctx.createMediaStreamSource(new MediaStream([micAudioTrack]));
				const micGain = ctx.createGain();
				micGain.gain.value = MIC_GAIN_BOOST;
				const destination = ctx.createMediaStreamDestination();
				systemSource.connect(destination);
				micSource.connect(micGain).connect(destination);
				stream.current.addTrack(destination.stream.getAudioTracks()[0]);
			} else if (systemAudioTrack) {
				stream.current.addTrack(systemAudioTrack);
			} else if (micAudioTrack) {
				stream.current.addTrack(micAudioTrack);
			}

			try {
				await videoTrack.applyConstraints({
					frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
					width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
					height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
				});
			} catch (constraintError) {
				console.warn(
					"Unable to lock 4K/60fps constraints, using best available track settings.",
					constraintError,
				);
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			let {
				width = DEFAULT_WIDTH,
				height = DEFAULT_HEIGHT,
				frameRate = TARGET_FRAME_RATE,
			} = videoTrack.getSettings();

			width = Math.floor(width / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;
			height = Math.floor(height / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;

			const videoBitsPerSecond = computeBitrate(width, height);
			const mimeType = selectMimeType();

			console.log(
				`Recording at ${width}x${height} @ ${frameRate ?? TARGET_FRAME_RATE}fps using ${mimeType} / ${Math.round(
					videoBitsPerSecond / BITS_PER_MEGABIT,
				)} Mbps`,
			);

			const hasAudio = stream.current.getAudioTracks().length > 0;
			const audioBitsPerSecond = hasAudio
				? systemAudioTrack
					? AUDIO_BITRATE_SYSTEM
					: AUDIO_BITRATE_VOICE
				: undefined;
			recorderOptions.current = { mimeType, videoBitsPerSecond, audioBitsPerSecond };

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			segmentHistory.current = [];
			recordingId.current = Date.now();
			const screenFileName = `${RECORDING_FILE_PREFIX}${recordingId.current}${VIDEO_FILE_EXTENSION}`;
			const webcamFileName = `${RECORDING_FILE_PREFIX}${recordingId.current}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`;

			screenRecorder.current = await createRecorderHandle(
				stream.current,
				{
					mimeType,
					videoBitsPerSecond,
					...(audioBitsPerSecond !== undefined ? { audioBitsPerSecond } : {}),
				},
				screenFileName,
			);
			screenRecorder.current.recorder.addEventListener(
				"error",
				() => {
					setRecording(false);
				},
				{ once: true },
			);

			const screenFilePathForDiag = screenRecorder.current.filePath;
			const wireTrackEndedDiag = (track: MediaStreamTrack | null | undefined, hint: string) => {
				if (!track) return;
				track.addEventListener("ended", () => {
					logRecorderDiag(screenFilePathForDiag, {
						tag: "track.ended",
						hint,
						kind: track.kind,
						label: track.label,
						readyState: track.readyState,
					});
				});
			};
			wireTrackEndedDiag(videoTrack, "screen.video");
			wireTrackEndedDiag(systemAudioTrack, "screen.audio");
			wireTrackEndedDiag(micAudioTrack, "mic");

			if (webcamStream.current) {
				webcamRecorder.current = await createRecorderHandle(
					webcamStream.current,
					{
						mimeType,
						videoBitsPerSecond: Math.min(videoBitsPerSecond, BITRATE_BASE),
					},
					webcamFileName,
				);
			}

			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			window.electronAPI?.setRecordingState(true);
			if (segmentRotationTimer.current !== null) window.clearTimeout(segmentRotationTimer.current);
			segmentRotationTimer.current = window.setTimeout(
				() => void doRotate.current(),
				SEGMENT_ROTATION_MS,
			);

			const activeScreenRecorder = screenRecorder.current;
			const activeWebcamRecorder = webcamRecorder.current;
			const activeRecordingId = recordingId.current;
			if (activeScreenRecorder) {
				activeScreenRecorder.recorder.addEventListener(
					"stop",
					() => {
						if (!allowAutoFinalize.current) {
							return;
						}
						finalizeRecording(
							activeScreenRecorder,
							activeWebcamRecorder ?? null,
							Math.max(0, getRecordingDurationMs()),
							activeRecordingId,
						);
					},
					{ once: true },
				);
			}
		} catch (error) {
			console.error("Failed to start recording:", error);
			const errorMsg = error instanceof Error ? error.message : "Failed to start recording";
			if (errorMsg.includes("Permission denied") || errorMsg.includes("NotAllowedError")) {
				toast.error(t("recording.permissionDenied"));
			} else {
				toast.error(errorMsg);
			}
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
			screenRecorder.current = null;
			webcamRecorder.current = null;
			teardownMedia();
		}
	};

	const togglePaused = () => {
		const activeScreenRecorder = screenRecorder.current?.recorder;
		if (!activeScreenRecorder || activeScreenRecorder.state === "inactive") {
			return;
		}

		const activeWebcamRecorder = webcamRecorder.current?.recorder;

		if (activeScreenRecorder.state === "paused") {
			try {
				activeScreenRecorder.resume();
				if (activeWebcamRecorder?.state === "paused") {
					activeWebcamRecorder.resume();
				}
				segmentStartedAt.current = Date.now();
				setPaused(false);
			} catch (error) {
				console.error("Failed to resume recording:", error);
			}
			return;
		}

		if (activeScreenRecorder.state !== "recording") {
			return;
		}

		try {
			accumulatedDurationMs.current = getRecordingDurationMs();
			segmentStartedAt.current = null;
			setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
			activeScreenRecorder.pause();
			if (activeWebcamRecorder?.state === "recording") {
				activeWebcamRecorder.pause();
			}
			setPaused(true);
		} catch (error) {
			console.error("Failed to pause recording:", error);
		}
	};

	const toggleRecording = () => {
		if (recording) {
			stopRecording.current();
			return;
		}

		if (countdownActive) {
			cancelCountdown();
			return;
		}

		void startRecordCountdown();
	};

	const restartRecording = async () => {
		if (restarting.current) return;

		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder || activeScreenRecorder.recorder.state === "inactive") return;

		const activeWebcamRecorder = webcamRecorder.current;
		const activeRecordingId = recordingId.current;

		if (segmentRotationTimer.current !== null) {
			window.clearTimeout(segmentRotationTimer.current);
			segmentRotationTimer.current = null;
		}

		restarting.current = true;
		discardRecordingId.current = activeRecordingId;

		const stopPromises = [
			new Promise<void>((resolve) => {
				activeScreenRecorder.recorder.addEventListener("stop", () => resolve(), { once: true });
			}),
		];

		if (
			activeWebcamRecorder?.recorder.state === "recording" ||
			activeWebcamRecorder?.recorder.state === "paused"
		) {
			stopPromises.push(
				new Promise<void>((resolve) => {
					activeWebcamRecorder.recorder.addEventListener("stop", () => resolve(), {
						once: true,
					});
				}),
			);
		}

		stopRecording.current();
		await Promise.all(stopPromises);

		try {
			await startRecording();
		} finally {
			restarting.current = false;
		}
	};

	useEffect(() => {
		if (!recording) {
			setElapsedSeconds(0);
			return;
		}

		setElapsedSeconds(Math.floor(getRecordingDurationMs() / 1000));
		if (paused) {
			return;
		}

		const interval = window.setInterval(() => {
			setElapsedSeconds(Math.floor(getRecordingDurationMs() / 1000));
		}, 250);

		return () => window.clearInterval(interval);
	}, [getRecordingDurationMs, paused, recording]);

	const cancelRecording = () => {
		if (segmentRotationTimer.current !== null) {
			window.clearTimeout(segmentRotationTimer.current);
			segmentRotationTimer.current = null;
		}
		const activeScreenRecorder = screenRecorder.current;
		if (
			activeScreenRecorder?.recorder.state === "recording" ||
			activeScreenRecorder?.recorder.state === "paused"
		) {
			const activeRecordingId = recordingId.current;
			discardRecordingId.current = activeRecordingId;
			allowAutoFinalize.current = false;

			stopRecording.current();
			return;
		}

		if (countdownActive) {
			cancelCountdown();
			return;
		}
	};

	return {
		recording,
		paused,
		elapsedSeconds,
		toggleRecording,
		togglePaused,
		restartRecording,
		cancelRecording,
		microphoneEnabled,
		setMicrophoneEnabled,
		microphoneDeviceId,
		setMicrophoneDeviceId,
		webcamDeviceId,
		setWebcamDeviceId,
		systemAudioEnabled,
		setSystemAudioEnabled,
		webcamEnabled,
		setWebcamEnabled,
	};
}
