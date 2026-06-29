const video = document.getElementById("webcam-preview");
const startBtn = document.getElementById("start-session-btn");
const examUrlInput = document.getElementById("exam-url");
const timeLimitInput = document.getElementById("time-limit");
const cameraStatus = document.getElementById("camera-status");
const errorDisplay = document.getElementById("error-display");
const shareScreenBtn = document.getElementById("share-screen-btn");
const screenStatusSpan = document.querySelector("#screen-status span");
const authBadge = document.getElementById("auth-badge");

const activeStudentRoll = localStorage.getItem('student_roll');
const activeStudentName = localStorage.getItem('student_name');

// Auth Guard
if (!activeStudentRoll) {
    window.location.href = 'index.html';
}

if (authBadge && activeStudentName) {
    authBadge.innerText = `Logged in as: ${activeStudentName} (${activeStudentRoll})`;
}

let isCameraReady = false;
let isScreenReady = false;

function checkReady() {
    startBtn.disabled = !(isCameraReady && isScreenReady);
}

// Disable initially
startBtn.disabled = true;

async function initSetup() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        video.srcObject = stream;
        cameraStatus.textContent = "Camera & Microphone are Ready";
        cameraStatus.style.color = "var(--success)";
        isCameraReady = true;
        checkReady();
    } catch (err) {
        console.error("Camera access denied:", err);
        cameraStatus.textContent = "Camera Access Denied";
        cameraStatus.style.color = "var(--danger)";
        errorDisplay.textContent = "Please allow camera and microphone access to continue.";
        errorDisplay.style.display = "block";
    }

    // Load saved config if exists
    const savedUrl = localStorage.getItem('exam_url');
    const savedTime = localStorage.getItem('exam_time');
    if (savedUrl) examUrlInput.value = savedUrl;
    if (savedTime) timeLimitInput.value = savedTime;
}

shareScreenBtn.addEventListener("click", async () => {
    try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: "monitor" // Prefer entire screen
            }
        });
        
        // Ensure they selected the entire screen (some browsers enforce this strictly)
        const track = screenStream.getVideoTracks()[0];
        if (track && track.getSettings().displaySurface !== 'monitor') {
            alert("Warning: For full proctoring, sharing the Entire Screen is required.");
            // We can strictly deny and stop the track, but browsers vary in support
            // track.stop();
            // return;
        }

        screenStatusSpan.textContent = "Screen Share: Active";
        screenStatusSpan.style.color = "var(--success)";
        shareScreenBtn.style.display = "none";
        
        isScreenReady = true;
        checkReady();

        track.onended = () => {
            isScreenReady = false;
            checkReady();
            screenStatusSpan.textContent = "Screen Share: Disconnected";
            screenStatusSpan.style.color = "var(--danger)";
            shareScreenBtn.style.display = "block";
        };

    } catch (err) {
        console.error("Screen share access denied:", err);
        alert("Screen sharing is required to start the exam.");
    }
});

startBtn.addEventListener("click", () => {
    const url = examUrlInput.value.trim();
    const time = timeLimitInput.value;

    if (!url) {
        alert("Please enter an Exam URL");
        return;
    }

    // Save configuration
    localStorage.setItem('exam_url', url);
    localStorage.setItem('exam_time', time);

    // Redirect to session
    window.location.href = 'session.html';
});

initSetup();
