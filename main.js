import {
    FaceLandmarker,
    ObjectDetector,
    FilesetResolver,
    DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";

const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const canvasCtx = canvasElement.getContext("2d");
const eventLog = document.getElementById("event-log");
const statusBadge = document.getElementById("status");
const scoreBadge = document.getElementById("integrity-score");
const aiStatus = document.getElementById("ai-status");
const startBtn = document.getElementById("start-btn");
const startOverlay = document.getElementById("start-overlay");
const errorDisplay = document.getElementById("error-display");
const examUrlInput = document.getElementById("exam-url");
const loadExamBtn = document.getElementById("load-exam-btn");
const examFrame = document.getElementById("exam-frame");
const examPlaceholder = document.getElementById("exam-placeholder");
const monitoringLockedPlaceholder = document.getElementById("monitoring-locked-placeholder");

const timerDisplay = document.getElementById("timer-display");
const timeLimitInput = document.getElementById("time-limit");

let faceLandmarker;
let objectDetector;
let drawingUtils;
let trustScore = 100;
let lastVideoTime = -1;
let lastEventTime = 0;
const EVENT_COOLDOWN = 3000;
let sessionId = null;
let examTimer = null;
let audioMonitor = null;
let lastExamResult = null;
let isMonitoringStarted = false;
let isExamUrlLoaded = false;

// Listen for messages from the exam iFrame
window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'EXAM_RESULT') {
        lastExamResult = event.data;
        logEvent("EXAM_SUBMITTED", { score: event.data.score, total: event.data.total });

        // Optionally auto-stop if they submitted everything
        // stopProctoring(); 
    }
});

class AudioMonitor {
    constructor(onVoiceDetected) {
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.onVoiceDetected = onVoiceDetected;
        this.threshold = 0.2; // Adjust sensitivity
        this.isActive = false;
    }

    async start() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.microphone = this.audioContext.createMediaStreamSource(stream);
            this.microphone.connect(this.analyser);
            this.analyser.fftSize = 256;
            this.isActive = true;
            this.monitor();
        } catch (err) {
            console.error("Audio access denied:", err);
            updateAIStatus("Audio: Access Denied");
        }
    }

    monitor() {
        if (!this.isActive) return;
        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(dataArray);
        const volume = dataArray.reduce((src, next) => src + next, 0) / dataArray.length / 255;

        if (volume > this.threshold) {
            this.onVoiceDetected(volume);
        }
        requestAnimationFrame(() => this.monitor());
    }

    stop() {
        this.isActive = false;
        if (this.audioContext) this.audioContext.close();
    }
}

async function apiCall(endpoint, method = 'POST', body = null) {
    try {
        const response = await fetch(endpoint, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : null
        });
        return await response.json();
    } catch (error) {
        console.error(`API Error (${endpoint}):`, error);
        return null;
    }
}

function updateAIStatus(msg) {
    if (aiStatus) aiStatus.innerText = `AI: ${msg}`;
}

function showError(msg) {
    if (errorDisplay) {
        errorDisplay.innerText = msg;
        errorDisplay.style.display = "block";
    }
    statusBadge.innerText = "Failure";
    statusBadge.style.color = "var(--danger)";
}

async function initialize() {
    try {
        updateAIStatus("Initializing Resolver...");
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );

        updateAIStatus("Loading Face Landmarker...");
        faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
                delegate: "GPU"
            },
            outputFaceBlendshapes: true,
            runningMode: "VIDEO",
            numFaces: 5
        });

        updateAIStatus("Loading Object Detector...");
        // Updated model path with tflite extension which is most reliable for the tasks API
        objectDetector = await ObjectDetector.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
                delegate: "GPU"
            },
            scoreThreshold: 0.25, // Lowered significantly to catch phones in tricky lighting
            runningMode: "VIDEO"
        });

        drawingUtils = new DrawingUtils(canvasCtx);
        statusBadge.innerText = "Ready to Start";
        updateAIStatus("Models Ready. Click Start.");
        startBtn.disabled = false;

        audioMonitor = new AudioMonitor((volume) => {
            const now = Date.now();
            if (now - lastEventTime > EVENT_COOLDOWN) {
                const penalty = 2;
                logEvent("VOICE_DETECTED", { volume: volume.toFixed(2), penalty });
                updateTrustScore(penalty);
                lastEventTime = now;
            }
        });

        startBtn.onclick = async () => {
            const timeLimit = parseInt(timeLimitInput.value);
            if (isNaN(timeLimit) || timeLimit <= 0) {
                alert("Please enter a valid time limit (minutes).");
                return;
            }

            startOverlay.style.display = "none";
            isMonitoringStarted = true;

            // If an exam was already loaded, show it now
            if (isExamUrlLoaded) {
                monitoringLockedPlaceholder.style.display = "none";
                examFrame.style.display = "block";
            }

            // Initialize Session
            const session = await apiCall('/api/sessions', 'POST', { user_id: 'Student_1' });
            if (session) {
                sessionId = session.session_id;
                console.log("Session Started:", sessionId);
            }
            startCamera();
            startFocusMonitoring();
            startTimer(timeLimit);
            audioMonitor.start();
        };

        loadExamBtn.onclick = () => {
            const url = examUrlInput.value.trim();
            if (url) {
                if (!url.startsWith('http')) {
                    alert("Please enter a valid URL (including http:// or https://)");
                    return;
                }
                examFrame.src = url;
                isExamUrlLoaded = true;
                examPlaceholder.style.display = "none";

                if (isMonitoringStarted) {
                    examFrame.style.display = "block";
                    monitoringLockedPlaceholder.style.display = "none";
                } else {
                    examFrame.style.display = "none";
                    monitoringLockedPlaceholder.style.display = "flex";
                }

                logEvent("EXAM_LOADED", { url });
            }
        };

    } catch (error) {
        showError("Initialization Error: " + error.message);
        updateAIStatus("FAILED: Check Console/Internet");
        console.error("Init failed:", error);
    }
}

function startTimer(minutes) {
    let secondsLeft = minutes * 60;
    timerDisplay.style.display = "block";

    updateTimerUI(secondsLeft);

    examTimer = setInterval(() => {
        secondsLeft--;
        updateTimerUI(secondsLeft);

        if (secondsLeft <= 0) {
            clearInterval(examTimer);
            handleExamCompletion();
        }
    }, 1000);
}

function updateTimerUI(secondsLeft) {
    const mins = Math.floor(secondsLeft / 60);
    const secs = secondsLeft % 60;
    timerDisplay.innerText = `Time: ${mins}:${secs < 10 ? '0' : ''}${secs}`;

    if (secondsLeft < 60) {
        timerDisplay.style.color = "var(--danger)";
        timerDisplay.style.borderColor = "var(--danger)";
    }
}

function handleExamCompletion() {
    logEvent("EXAM_STOPPED", {
        reason: "Time limit reached",
        final_trust_score: Math.floor(trustScore)
    });
    stopProctoring();

    let examResultHtml = '';
    if (lastExamResult) {
        examResultHtml = `
            <div style="margin-top: 1rem; padding: 1rem; background: rgba(34, 197, 94, 0.1); border: 1px solid var(--success); border-radius: 0.5rem;">
                <p style="color: var(--success); font-weight: bold; margin-bottom: 0.5rem;">Exam Score: ${lastExamResult.score} / ${lastExamResult.total}</p>
                <p style="font-size: 0.8rem; color: var(--text-secondary);">Correct/Wrong answers are detailed in the exam log above.</p>
            </div>`;
    } else {
        examResultHtml = `
            <div style="margin-top: 1rem; padding: 1rem; background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger); border-radius: 0.5rem;">
                <p style="color: var(--danger); font-weight: bold;">Exam: Not Submitted</p>
            </div>`;
    }

    examFrame.style.display = "none";
    examPlaceholder.innerHTML = `
        <div style="text-align: center; max-width: 400px; margin: 0 auto;">
            <h2 style="color: var(--accent); margin-bottom: 1rem;">Session Summary</h2>
            <div style="background: var(--bg-color); padding: 1.5rem; border-radius: 1rem; border: 1px solid #334155;">
                <p style="font-size: 1.2rem; font-weight: bold; color: var(--success)">Exam Completed Successfully</p>
                <p style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.5rem;">The evaluator will review your session.</p>
                
                ${examResultHtml}
            </div>
            <button onclick="location.reload()" class="primary-btn" style="margin-top: 1.5rem; width: 100%;">Return to Dashboard</button>
        </div>
    `;
    examPlaceholder.style.display = "flex";

    alert("Session complete. Review your results.");
}

function stopProctoring() {
    if (examTimer) clearInterval(examTimer);
    if (audioMonitor) audioMonitor.stop();

    const stream = video.srcObject;
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }

    updateAIStatus("Session Ended.");
    statusBadge.innerText = "Completed";
}

function updateTrustScore(penalty) {
    trustScore = Math.max(0, trustScore - penalty);
    if (scoreBadge) {
        scoreBadge.innerText = `TrustScore: ${Math.floor(trustScore)}%`;
        if (trustScore < 70) scoreBadge.style.color = "var(--danger)";
        else if (trustScore < 90) scoreBadge.style.color = "#fbbf24";
    }
}

function startCamera() {
    updateAIStatus("Activating Camera...");
    navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
        .then((stream) => {
            video.srcObject = stream;
            video.onloadedmetadata = () => {
                canvasElement.width = video.videoWidth;
                canvasElement.height = video.videoHeight;
                video.play();
                updateAIStatus("Monitoring Active.");
                predictWebcam();
            };
        })
        .catch((err) => {
            showError("Camera Access Error: " + err.message);
        });
}

function logEvent(event, data = {}) {
    const entry = document.createElement("div");
    entry.className = "log-entry";
    const timestamp = new Date().toLocaleTimeString();
    entry.innerHTML = `
        <span class="log-time">[${timestamp}]</span>
        <span class="log-event">${event}</span>
        <pre>${JSON.stringify(data, null, 2)}</pre>
    `;
    eventLog.prepend(entry);

    if (sessionId) {
        apiCall('/api/events', 'POST', {
            session_id: sessionId,
            event_type: event,
            data: data
        });
    }
}

async function predictWebcam() {
    // Check if video is playing/not stopped
    if (!video.srcObject || video.srcObject.getTracks().every(t => t.readyState === 'ended')) {
        return;
    }

    if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const startTimeMs = performance.now();

        const faceResults = faceLandmarker.detectForVideo(video, startTimeMs);
        const objectResults = objectDetector.detectForVideo(video, startTimeMs);

        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        // Process Objects
        if (objectResults && objectResults.detections.length > 0) {
            handleObjectDetections(objectResults);
        } else {
            // Update status if no objects found but faces are
            if (faceResults && faceResults.faceLandmarks.length > 0) {
                updateAIStatus(`Tracking: ${faceResults.faceLandmarks.length} face(s)`);
            }
        }

        // Process Faces
        if (faceResults && faceResults.faceLandmarks.length > 0) {
            handleFaceDetections(faceResults);
        } else {
            handleNoFaceFound();
        }
    }
    window.requestAnimationFrame(predictWebcam);
}

function handleNoFaceFound() {
    const now = Date.now();
    if (now - lastEventTime > EVENT_COOLDOWN) {
        const penalty = 5;
        logEvent("NO_FACE_DETECTED", { message: "Subject absent", penalty });
        updateTrustScore(penalty);
        lastEventTime = now;
    }
    updateAIStatus("Tracking: No Face Found");
}

function handleFaceDetections(results) {
    const faceCount = results.faceLandmarks.length;
    const now = Date.now();

    if (faceCount > 1 && (now - lastEventTime > EVENT_COOLDOWN)) {
        const penalty = 10;
        logEvent("MULTIPLE_FACES", { count: faceCount, penalty });
        updateTrustScore(penalty);
        lastEventTime = now;
    }

    results.faceLandmarks.forEach((landmarks) => {
        // Draw face grid
        drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "#ffffff40", lineWidth: 1 });
        drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: "#FF3030", lineWidth: 2 });
        drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: "#30FF30", lineWidth: 2 });

        const nose = landmarks[4];
        const leftEye = landmarks[33];
        const rightEye = landmarks[263];
        const noseRelativeX = nose.x - (leftEye.x + rightEye.x) / 2;

        if (Math.abs(noseRelativeX) > 0.05 && (now - lastEventTime > EVENT_COOLDOWN)) {
            const penalty = 3;
            logEvent("LOOK_AWAY", { deviation: noseRelativeX.toFixed(3), penalty });
            updateTrustScore(penalty);
            lastEventTime = now;
        }
    });
}

function handleObjectDetections(results) {
    const now = Date.now();
    let detectedObjects = [];

    results.detections.forEach(detection => {
        const category = detection.categories[0].categoryName;
        const score = detection.categories[0].score;
        const box = detection.boundingBox;

        detectedObjects.push(`${category}(${Math.round(score * 100)}%)`);

        // Draw detection box
        canvasCtx.strokeStyle = "#38bdf8";
        canvasCtx.lineWidth = 2;
        canvasCtx.strokeRect(box.originX, box.originY, box.width, box.height);

        // Label on canvas
        canvasCtx.fillStyle = "#38bdf8";
        canvasCtx.font = "12px sans-serif";
        canvasCtx.fillText(`${category} ${Math.round(score * 100)}%`, box.originX, box.originY > 15 ? box.originY - 5 : 15);

        // Security check
        const prohibited = ["cell phone", "book", "laptop", "tablet"];
        if (prohibited.includes(category) && score > 0.25) {
            if (now - lastEventTime > EVENT_COOLDOWN) {
                const penalty = 20;
                logEvent("PROHIBITED_OBJECT", { type: category.toUpperCase(), confidence: score.toFixed(2), penalty });
                updateTrustScore(penalty);
                lastEventTime = now;
            }
        }
    });

    if (detectedObjects.length > 0) {
        updateAIStatus(`Seeing: ${detectedObjects.join(", ")}`);
    }
}

function startFocusMonitoring() {
    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            const penalty = 15;
            logEvent("TAB_SWITCH", { message: "User left the proctoring tab", penalty });
            updateTrustScore(penalty);
        }
    });

    window.addEventListener('blur', () => {
        const penalty = 5;
        logEvent("WINDOW_UNFOCUSED", { message: "User moved focus away from the browser", penalty });
        updateTrustScore(penalty);
    });
}

initialize();
