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
const examFrame = document.getElementById("exam-frame");
const monitoringLockedPlaceholder = document.getElementById("monitoring-locked-placeholder");
const timerDisplay = document.getElementById("timer-display");

let faceLandmarker;
let objectDetector;
let drawingUtils;
let trustScore = 100;
const TRUST_SCORE_THRESHOLD = 30; // Auto-terminate if score drops below this
let lastVideoTime = -1;
let lastEventTime = 0;
const EVENT_COOLDOWN = 3000;
let sessionId = null;
let examTimer = null;
let audioMonitor = null;
let lastExamResult = null;
let isMonitoringStarted = false;

// Configuration from LocalStorage
const examUrl = localStorage.getItem('exam_url');
const examTime = parseInt(localStorage.getItem('exam_time')) || 30;

if (!examUrl) {
    window.location.href = 'setup.html';
}

// Listen for messages from the exam iFrame
window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'EXAM_RESULT') {
        lastExamResult = event.data;
        logEvent("EXAM_SUBMITTED", { score: event.data.score, total: event.data.total });

        // Save result and redirect after a short delay
        localStorage.setItem('final_exam_score', event.data.score);
        localStorage.setItem('total_questions', event.data.total);

        setTimeout(() => {
            handleExamCompletion("Exam Submitted");
        }, 2000);
    }
});

class AudioMonitor {
    constructor(onVoiceDetected) {
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.onVoiceDetected = onVoiceDetected;
        this.threshold = 0.2;
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

function showToast(message) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    
    const toast = document.createElement("div");
    toast.className = "toast-message";
    toast.innerHTML = `⚠️ ${message}`;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add("fade-out");
        toast.addEventListener("animationend", () => {
            toast.remove();
        });
    }, 4000);
}

async function startSnapshotStream() {
    setInterval(() => {
        if (!isMonitoringStarted || !sessionId) return;
        
        try {
            // Draw current webcam frame to local canvas and export as base64
            // In a real scenario, this would also include the screen share stream
            const snapshotData = canvasElement.toDataURL('image/jpeg', 0.5);
            
            apiCall('/api/snapshots', 'POST', {
                session_id: sessionId,
                snapshot_data: snapshotData,
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            console.error("Snapshot error:", e);
        }
    }, 10000); // 10 seconds interval
}

function enforceBrowserSecurity() {
    // Prevent right-click
    document.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showToast("Right-click is disabled during the exam.");
    });

    // Prevent copy/paste
    document.addEventListener("copy", (e) => {
        e.preventDefault();
        showToast("Copying is disabled.");
    });
    document.addEventListener("paste", (e) => {
        e.preventDefault();
        showToast("Pasting is disabled.");
    });

    // Prevent developer tools and shortcuts
    document.addEventListener("keydown", (e) => {
        const forbiddenKeys = ["F12"];
        const isCtrlShift = e.ctrlKey && e.shiftKey;
        
        if (forbiddenKeys.includes(e.key) || 
            (isCtrlShift && ["I", "J", "C"].includes(e.key.toUpperCase())) || 
            (e.ctrlKey && ["U", "C", "V", "X"].includes(e.key.toUpperCase()))) {
            e.preventDefault();
            const penalty = 5;
            logEvent("UNAUTHORIZED_SHORTCUT", { key: e.key, penalty: penalty });
            updateTrustScore(penalty, "Unauthorized keyboard shortcut used.");
        }
    });

    // Enforce Fullscreen
    document.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement && isMonitoringStarted) {
            const penalty = 20;
            logEvent("FULLSCREEN_EXITED", { penalty: penalty });
            updateTrustScore(penalty, "Exited full-screen mode!");
            // Attempt to re-enter
            try {
                document.documentElement.requestFullscreen();
            } catch (err) {}
        }
    });
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
        objectDetector = await ObjectDetector.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
                delegate: "GPU"
            },
            scoreThreshold: 0.25,
            runningMode: "VIDEO"
        });

        drawingUtils = new DrawingUtils(canvasCtx);
        statusBadge.innerText = "Ready to Start";
        updateAIStatus("Models Ready. Click Start.");
        startBtn.disabled = false;
        startBtn.textContent = "Start Monitoring";

        audioMonitor = new AudioMonitor((volume) => {
            const now = Date.now();
            if (now - lastEventTime > EVENT_COOLDOWN) {
                const penalty = 2;
                logEvent("VOICE_DETECTED", { volume: volume.toFixed(2), penalty });
                updateTrustScore(penalty, "Voice detected in the background.");
                lastEventTime = now;
            }
        });

        startBtn.onclick = async () => {
            try {
                await document.documentElement.requestFullscreen();
            } catch (err) {
                alert("Please manually enter fullscreen to continue.");
            }

            enforceBrowserSecurity();

            startOverlay.style.display = "none";
            isMonitoringStarted = true;

            // Show locked exam
            examFrame.src = examUrl;
            monitoringLockedPlaceholder.style.display = "none";
            examFrame.style.display = "block";

            // Initialize Session with dynamic student Roll No
            const studentRoll = localStorage.getItem('student_roll') || 'anonymous_student';
            const session = await apiCall('/api/sessions', 'POST', { user_id: studentRoll });
            if (session) {
                sessionId = session.session_id;
                localStorage.setItem('session_id', sessionId);
            }
            startCamera();
            startFocusMonitoring();
            startSnapshotStream();
            startTimer(examTime);
            audioMonitor.start();
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
            handleExamCompletion("Time limit reached");
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

function handleExamCompletion(reason) {
    logEvent("EXAM_STOPPED", {
        reason: reason,
        final_trust_score: Math.floor(trustScore)
    });
    stopProctoring();

    // Redirect to results page
    window.location.href = 'results.html';
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

function updateTrustScore(penalty, reason) {
    trustScore = Math.max(0, trustScore - penalty);
    if (scoreBadge) {
        scoreBadge.innerText = `TrustScore: ${Math.floor(trustScore)}%`;
        if (trustScore < 50) scoreBadge.style.color = "var(--danger)";
    }
    
    if (reason) {
        showToast(`${reason} (-${penalty} points)`);
    }

    if (trustScore < TRUST_SCORE_THRESHOLD && isMonitoringStarted) {
        logEvent("TRUST_SCORE_VIOLATION", { score: trustScore });
        showToast("TrustScore too low. Auto-terminating exam...");
        setTimeout(() => {
            handleExamCompletion("Auto-terminated due to trust score policy");
        }, 3000);
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
    if (sessionId) {
        apiCall('/api/events', 'POST', {
            session_id: sessionId,
            event_type: event,
            data: data
        });
    }

    const entry = document.createElement("div");
    entry.className = "log-entry";
    const timestamp = new Date().toLocaleTimeString();
    entry.innerHTML = `
        <span class="log-time">[${timestamp}]</span>
        <span class="log-event">${event}</span>
        <pre>${JSON.stringify(data, null, 2)}</pre>
    `;
    eventLog.prepend(entry);
}

async function predictWebcam() {
    if (!video.srcObject || video.srcObject.getTracks().every(t => t.readyState === 'ended')) {
        return;
    }

    if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const startTimeMs = performance.now();

        const faceResults = faceLandmarker.detectForVideo(video, startTimeMs);
        const objectResults = objectDetector.detectForVideo(video, startTimeMs);

        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        if (objectResults && objectResults.detections.length > 0) {
            handleObjectDetections(objectResults);
        } else {
            if (faceResults && faceResults.faceLandmarks.length > 0) {
                updateAIStatus(`Tracking: ${faceResults.faceLandmarks.length} face(s)`);
            }
        }

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
        updateTrustScore(penalty, "No face detected in camera.");
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
        updateTrustScore(penalty, "Multiple faces detected.");
        lastEventTime = now;
    }

    results.faceLandmarks.forEach((landmarks) => {
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
            updateTrustScore(penalty, "Looking away from screen.");
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

        canvasCtx.strokeStyle = "#38bdf8";
        canvasCtx.lineWidth = 2;
        canvasCtx.strokeRect(box.originX, box.originY, box.width, box.height);

        const prohibited = ["cell phone", "book", "laptop", "tablet"];
        if (prohibited.includes(category) && score > 0.25) {
            if (now - lastEventTime > EVENT_COOLDOWN) {
                const penalty = 20;
                logEvent("PROHIBITED_OBJECT", { type: category.toUpperCase(), confidence: score.toFixed(2), penalty });
                updateTrustScore(penalty, `Prohibited object detected: ${category}`);
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
            updateTrustScore(penalty, "Switched away from exam tab.");
        }
    });

    window.addEventListener('blur', () => {
        const penalty = 5;
        logEvent("WINDOW_UNFOCUSED", { message: "User moved focus away from the browser", penalty });
        updateTrustScore(penalty, "Exam window lost focus.");
    });
}

initialize();
