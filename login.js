// Clear any previous session data when loading the login page
localStorage.removeItem('student_roll');
localStorage.removeItem('student_name');
localStorage.removeItem('session_id');

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const submitBtn = document.getElementById('submit-btn');
    const errorDisplay = document.getElementById('error-display');
    
    submitBtn.disabled = true;
    submitBtn.textContent = "Verifying...";
    errorDisplay.style.display = 'none';

    const studentData = {
        roll_no: document.getElementById('roll_no').value.trim(),
        name: document.getElementById('name').value.trim(),
        email: document.getElementById('email').value.trim(),
        college_name: document.getElementById('college_name').value.trim(),
        cgpa: parseFloat(document.getElementById('cgpa').value)
    };

    try {
        const response = await fetch('/api/students', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(studentData)
        });

        const data = await response.json();

        if (response.ok) {
            // Save identifying roll_no and visual name to LocalStorage for offline use in session
            localStorage.setItem('student_roll', studentData.roll_no);
            localStorage.setItem('student_name', studentData.name);
            
            // Advance to the Hardware Setup Screen
            window.location.href = 'setup.html';
        } else {
            throw new Error(data.error || "Failed to authenticate");
        }
    } catch (error) {
        console.error("Login Error:", error);
        errorDisplay.textContent = error.message;
        errorDisplay.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = "Authenticate & Continue";
    }
});
