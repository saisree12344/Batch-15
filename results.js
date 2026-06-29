const finalScoreDisplay = document.getElementById("final-score");
const examResultSection = document.getElementById("exam-result-section");

const resName = document.getElementById("res-name");
const resRoll = document.getElementById("res-roll");
const resEmail = document.getElementById("res-email");
const resCollege = document.getElementById("res-college");
const resCgpa = document.getElementById("res-cgpa");
const finalTrustScoreDisplay = document.getElementById("final-trust-score");

async function apiCall(endpoint) {
    try {
        const response = await fetch(endpoint);
        if (!response.ok) throw new Error("API call failed");
        return await response.json();
    } catch (error) {
        console.error(error);
        return null;
    }
}

async function initResults() {
    const score = localStorage.getItem('final_exam_score');
    const total = localStorage.getItem('total_questions');
    const studentRoll = localStorage.getItem('student_roll');
    const sessionId = localStorage.getItem('session_id');

    // 1. Populate Exam Score
    if (score !== null && total !== null) {
        finalScoreDisplay.textContent = `${score} / ${total}`;
    } else {
        finalScoreDisplay.textContent = "Not Submitted";
        finalScoreDisplay.style.color = "var(--danger)";
    }

    // 2. Fetch and Populate Student Details
    if (studentRoll) {
        const studentInfo = await apiCall(`/api/students/${studentRoll}`);
        if (studentInfo) {
            resName.textContent = studentInfo.name || "--";
            resRoll.textContent = studentInfo.roll_no || "--";
            resEmail.textContent = studentInfo.email || "--";
            resCollege.textContent = studentInfo.college_name || "--";
            resCgpa.textContent = studentInfo.cgpa ? studentInfo.cgpa.toFixed(2) : "--";
        } else {
            resRoll.textContent = studentRoll;
        }
    }

    // 3. Fetch Final Trust Score from Session
    if (sessionId) {
        const sessionInfo = await apiCall(`/api/sessions/${sessionId}`);
        if (sessionInfo && sessionInfo.trust_score !== undefined) {
            const tScore = Math.floor(sessionInfo.trust_score);
            finalTrustScoreDisplay.textContent = `${tScore}%`;
            if (tScore < 50) {
                finalTrustScoreDisplay.style.color = "var(--danger)";
            }
        }
    }
}

initResults();
