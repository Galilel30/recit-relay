// Determine Relay URL and PIN from Hash or default
const DEFAULT_RELAY = 'http://localhost:3001';
const urlParams = new URLSearchParams(window.location.hash.slice(1));
const RELAY_URL = urlParams.get('relay') || DEFAULT_RELAY;
const AUTO_PIN = urlParams.get('pin') || '';

console.log('📡 Connecting to Relay:', RELAY_URL);
if (AUTO_PIN) console.log('🔑 Auto-PIN from QR:', AUTO_PIN);

const socket = io(RELAY_URL, {
    transports: ['websocket'],   // Skip polling — required for Render.com
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
});

// Anti-Cheat Config
const PENALTY_SECONDS = 60;
let penaltyTimer = null;
let penaltySecondsLeft = 0;

// State
let currentScreen = 'login-screen';
let studentName = '';
let myJoinPin = ''; // Track our active join PIN
let isJoined = false; // Track if we successfully joined
let joinTimeout = null; // Timeout to re-enable button if join fails
let examQuestions = [];
let currentQuestionIndex = 0;
let answers = {};
let canEdit = true;
let isUnloading = false;

// DOM Elements
const screens = {
    login: document.getElementById('login-screen'),
    waiting: document.getElementById('waiting-screen'),
    exam: document.getElementById('exam-screen'),
    result: document.getElementById('result-screen')
};

const inputs = {
    pin: document.getElementById('pin-input'),
    name: document.getElementById('name-input'),
    joinBtn: document.getElementById('join-btn'),
    error: document.getElementById('login-error')
};

// Auto-fill PIN from QR code URL
if (AUTO_PIN) {
    inputs.pin.value = AUTO_PIN;
    inputs.pin.readOnly = true;
    inputs.pin.style.opacity = '0.7';
}
// Restore name from previous session if available
const savedName = localStorage.getItem('recit_student_name');
if (savedName) inputs.name.value = savedName;

const examUI = {
    timer: document.getElementById('exam-timer'),
    counter: document.getElementById('question-counter'),
    text: document.getElementById('question-text'),
    optionsContainer: document.getElementById('options-container'),
    textContainer: document.getElementById('text-answer-container'),
    textArea: document.getElementById('text-answer'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn')
};

const antiCheat = {
    overlay: document.getElementById('violation-overlay'),
    resumeBtn: document.getElementById('resume-btn')
};

// UI Functions
function showScreen(screenName) {
    Object.values(screens).forEach(el => el.classList.remove('active'));
    screens[screenName.replace('-screen', '')].classList.add('active');
    currentScreen = screenName;
}

// Logic
inputs.joinBtn.addEventListener('click', () => {
    const pin = inputs.pin.value.trim();
    const name = inputs.name.value.trim();

    if (pin.length < 6 || name.length === 0) {
        inputs.error.textContent = 'Please enter a valid PIN and Name.';
        return;
    }

    inputs.error.textContent = '';
    inputs.joinBtn.disabled = true;

    if (!socket.connected) {
        inputs.joinBtn.textContent = '⏳ Waking relay...';
        inputs.error.style.color = '#f59e0b';
        inputs.error.textContent = 'Relay is starting up, please wait...';
        socket.once('connect', () => doJoin(pin, name));
    } else {
        inputs.joinBtn.textContent = 'Joining...';
        doJoin(pin, name);
    }
});

function doJoin(pin, name) {
    studentName = name;
    myJoinPin = pin;
    inputs.joinBtn.textContent = 'Joining...';
    inputs.joinBtn.disabled = true;
    inputs.error.style.color = '';
    inputs.error.textContent = '';
    localStorage.setItem('recit_student_name', name);

    socket.emit('join-room', { pin, role: 'student' });
    socket.emit('relay-event', { pin, event: 'join-session', data: { pin, name, socketId: socket.id } });

    // Safety net: re-enable button if no join confirmation within 15s
    clearTimeout(joinTimeout);
    joinTimeout = setTimeout(() => {
        if (!isJoined) {
            inputs.joinBtn.disabled = false;
            inputs.joinBtn.textContent = 'Join Session';
            inputs.error.style.color = '#ef4444';
            inputs.error.textContent = 'No response from host. Check the PIN and try again.';
        }
    }, 15000);

    // Try to enter fullscreen
    try {
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        }
    } catch (e) { console.log('Fullscreen failed'); }
}

// Socket Events
let connectAttempts = 0;
socket.on('connect', () => {
    console.log('✅ Connected to relay. Socket ID:', socket.id);
    connectAttempts = 0;
    if (inputs.error) inputs.error.style.color = '';
    if (inputs.error && inputs.error.textContent.includes('Waking')) {
        inputs.error.textContent = '';
    }

    // Auto-rejoin if we were already in a session (socket ID changed)
    if (myJoinPin && studentName && !isJoined) {
        console.log('🔄 Rejoining with new socket ID...');
        socket.emit('join-room', { pin: myJoinPin, role: 'student' });
        socket.emit('relay-event', { pin: myJoinPin, event: 'join-session', data: { pin: myJoinPin, name: studentName, socketId: socket.id } });
    } else if (myJoinPin && studentName && isJoined) {
        // Reconnected after a drop — rejoin to sync state
        console.log('🔄 Reconnected — syncing session state...');
        socket.emit('join-room', { pin: myJoinPin, role: 'student' });
        socket.emit('relay-event', { pin: myJoinPin, event: 'join-session', data: { pin: myJoinPin, name: studentName, socketId: socket.id } });
    }
});

socket.on('connect_error', () => {
    connectAttempts++;
    if (connectAttempts <= 3) {
        inputs.error.style.color = '#f59e0b';
        inputs.error.textContent = `⏳ Waking up relay server... (${connectAttempts * 5}s / ~30s)`;
    } else if (connectAttempts <= 8) {
        inputs.error.style.color = '#f59e0b';
        inputs.error.textContent = `⏳ Still waking up... this can take up to 30 seconds on first connect.`;
    } else {
        inputs.error.style.color = '#ef4444';
        inputs.error.textContent = '❌ Cannot reach relay. Check your internet connection.';
        // Re-enable button so they can retry
        inputs.joinBtn.disabled = false;
        inputs.joinBtn.textContent = 'Join Session';
    }
});

socket.on('error', (err) => {
    inputs.error.textContent = err.message || 'Connection Error';
    inputs.joinBtn.disabled = false;
    inputs.joinBtn.textContent = 'Join Exam';
    if (currentScreen !== 'login-screen') {
        alert(err.message);
    }
});

socket.on('joined', (data) => {
    if (data.targetSid && data.targetSid !== socket.id) {
        if (!myJoinPin || isJoined) return;
        console.log('⚠️ targetSid mismatch (transport upgrade?), accepting anyway for our session');
    }

    clearTimeout(joinTimeout); // Cancel the safety net
    console.log('✅ Join confirmed:', data);
    isJoined = true;
    if (inputs.joinBtn) {
        inputs.joinBtn.disabled = false;
        inputs.joinBtn.textContent = 'Join Session';
    }
    document.getElementById('student-name-display').textContent = studentName;

    saveSession(myJoinPin || inputs.pin.value || localStorage.getItem('recit_exam_pin'), studentName);

    if (data.status === 'active') {
        showScreen('exam-screen');
        initWatermark();
        if (data.existingAnswers) answers = { ...data.existingAnswers };
    } else {
        showScreen('waiting-screen');
    }
});

socket.on('exam-started', (data) => {
    console.log('Exam started signal received:', data);

    // Reset/Prepare state
    examQuestions = [];
    currentQuestionIndex = 0;
    canEdit = true;

    // Restore answers if reconnecting
    if (data.existingAnswers) {
        answers = { ...data.existingAnswers };
    } else {
        answers = {};
    }

    // Show timer
    if (data.duration > 0 || data.timeLeft > 0) {
        examUI.timer.style.display = 'flex';
        updateTimerUI(data.timeLeft !== undefined ? data.timeLeft : (data.duration * 60));
    } else {
        examUI.timer.style.display = 'none';
    }

    // Switch to screen
    showScreen('exam-screen');

    // Show Watermark
    initWatermark();

    // Back-Button Guard for Mobile
    if (window.history.pushState) {
        window.history.pushState(null, null, window.location.href);
        window.onpopstate = function() {
            if (currentScreen === 'exam-screen') {
                window.history.pushState(null, null, window.location.href);
                alert('Navigation is disabled during the exam. Use the "Finish Exam" button to exit.');
            }
        };
    }

    // Show loading state if questions haven't arrived yet
    examUI.optionsContainer.innerHTML = '';
    examUI.textContainer.style.display = 'none';
    examUI.text.innerHTML = '<div class="loading-questions">Initializing exam...</div>';

    // Questions might be included if it's a late join or old server
    if (data.questions && data.questions.length > 0) {
        examQuestions = data.questions;
        renderQuestion();
    } else {
        // SAFETY: If questions don't arrive in 800ms, request them explicitly
        setTimeout(() => {
            if (examQuestions.length === 0 && currentScreen === 'exam-screen') {
                console.log('⏳ Questions still loading... requesting from server');
                const pin = inputs.pin.value || localStorage.getItem('recit_exam_pin');
                socket.emit('relay-event', { pin, event: 'request-questions', data: { socketId: socket.id } });
            }
        }, 800);
    }
});

socket.on('questions-loaded', (data) => {
    if (data.targetSid && data.targetSid !== socket.id) return;
    if (!data.questions || data.questions.length === 0) return;
    console.log('✅ Questions received:', data.questions.length);
    examQuestions = data.questions;
    renderQuestion();
});

socket.on('timer-tick', (data) => {
    if (examUI.timer.style.display === 'none' && currentScreen === 'exam-screen') {
        examUI.timer.style.display = 'flex';
    }
    updateTimerUI(data.timeLeft);
});

socket.on('duration-updated', (data) => {
    if (currentScreen === 'waiting-screen' || currentScreen === 'exam-screen') {
        updateTimerUI(data.timeLeft);
    }
});

socket.on('exam-ended', (data) => {
    if (data.targetSid && data.targetSid !== socket.id) return;
    canEdit = false;
    clearSession();
    showScreen('result-screen');

    const resultContent = document.querySelector('.result-content');
    if (data && typeof data.score === 'number') {
        const percentage = Math.round((data.score / data.total) * 100);
        let message = "Good effort!";
        if (percentage >= 90) message = "Outstanding!";
        else if (percentage >= 75) message = "Great job!";
        else if (percentage >= 60) message = "Well done.";

        resultContent.innerHTML = `
            <div class="score-card">
                <div class="score-label">Your Score</div>
                <div class="score-value">${data.score} / ${data.total}</div>
                <div class="score-message">${message}</div>
            </div>
            <h2>Exam Completed</h2>
            <p>Your results have been recorded.</p>
        `;
    } else {
        resultContent.innerHTML = `
            <div class="icon">✅</div>
            <h2>Exam Completed!</h2>
            <p>Your answers have been recorded.</p>
            <p>You may now close this window.</p>
        `;
    }
});

function updateTimerUI(timeLeft) {
    if (timeLeft < 0) timeLeft = 0;
    const mins = Math.floor(timeLeft / 60);
    const secs = timeLeft % 60;
    examUI.timer.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    if (timeLeft <= 60) {
        examUI.timer.classList.add('warning');
    } else {
        examUI.timer.classList.remove('warning');
    }
}

// Exam Navigation & Rendering
function renderQuestion() {
    if (!examQuestions || examQuestions.length === 0) return;

    const question = examQuestions[currentQuestionIndex];
    examUI.counter.textContent = `Question ${currentQuestionIndex + 1} / ${examQuestions.length}`;

    const progress = ((currentQuestionIndex + 1) / examQuestions.length) * 100;
    const progressBar = document.getElementById('exam-progress-bar');
    if (progressBar) progressBar.style.width = `${progress}%`;

    examUI.text.textContent = question.text;
    examUI.optionsContainer.innerHTML = '';

    if (question.type === 'multiple-choice' || question.type === 'true-false') {
        examUI.optionsContainer.style.display = 'block';
        examUI.textContainer.style.display = 'none';

        const options = question.options || (question.type === 'true-false' ? ['True', 'False'] : []);

        options.forEach(opt => {
            const btn = document.createElement('button');
            btn.className = 'option-btn';
            btn.textContent = opt;
            if (answers[question.id] === opt) {
                btn.classList.add('selected');
            }

            btn.addEventListener('click', () => {
                if (!canEdit) return;
                answers[question.id] = opt;
                const pin = inputs.pin.value || localStorage.getItem('recit_exam_pin');
                socket.emit('relay-event', { pin, event: 'submit-answer', data: { socketId: socket.id, questionId: question.id, answer: opt } });
                Array.from(examUI.optionsContainer.children).forEach(c => c.classList.remove('selected'));
                btn.classList.add('selected');
            });

            examUI.optionsContainer.appendChild(btn);
        });
    } else {
        examUI.optionsContainer.style.display = 'none';
        examUI.textContainer.style.display = 'block';
        examUI.textArea.value = answers[question.id] || '';

        examUI.textArea.onblur = () => {
            if (!canEdit) return;
            const val = examUI.textArea.value;
            answers[question.id] = val;
            const pin = inputs.pin.value || localStorage.getItem('recit_exam_pin');
            socket.emit('relay-event', { pin, event: 'submit-answer', data: { socketId: socket.id, questionId: question.id, answer: val } });
        };
    }

    examUI.prevBtn.disabled = currentQuestionIndex === 0;
    examUI.nextBtn.textContent = currentQuestionIndex === examQuestions.length - 1 ? 'Finish Exam' : 'Next Question';
}

examUI.prevBtn.addEventListener('click', () => {
    if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        renderQuestion();
    }
});

examUI.nextBtn.addEventListener('click', () => {
    if (currentQuestionIndex < examQuestions.length - 1) {
        currentQuestionIndex++;
        renderQuestion();
    } else {
        if (confirm('Are you sure you want to finish the exam?')) {
            showScreen('result-screen');
            document.querySelector('.result-content h2').textContent = 'Waiting for exam to end...';
        }
    }
});

document.getElementById('refresh-btn').addEventListener('click', () => {
    if (confirm('Refreshing will briefly disconnect you. Your progress is saved. Continue?')) {
        location.reload();
    }
});

// Anti-Cheating Logic
function initWatermark() {
    const container = document.getElementById('watermark-container');
    if (!container) return;
    container.innerHTML = '';
    container.style.display = 'block';

    const text = `${studentName} • SECURE EXAM • ${new Date().toLocaleDateString()}`;
    for (let i = 0; i < 30; i++) {
        const el = document.createElement('div');
        el.className = 'watermark-text';
        el.textContent = text;
        el.style.top = `${Math.random() * 100}%`;
        el.style.left = `${Math.random() * 100}%`;
        container.appendChild(el);
    }
}

// Block copy/paste/right-click
['contextmenu', 'copy', 'cut', 'paste', 'keydown'].forEach(event => {
    document.addEventListener(event, (e) => {
        if (currentScreen !== 'exam-screen') return;
        
        // Allow typing in text areas
        if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
            if (event === 'keydown') return;
        }

        // Block shortcuts
        if (event === 'keydown') {
            const forbiddenKeys = ['c', 'v', 'x', 'p', 'i', 'j', 'u'];
            if ((e.ctrlKey || e.metaKey) && forbiddenKeys.includes(e.key.toLowerCase())) {
                e.preventDefault();
                return false;
            }
            return;
        }

        e.preventDefault();
        return false;
    });
});

document.addEventListener('visibilitychange', () => {
    if (isUnloading) return;
    if (document.visibilityState === 'hidden' && currentScreen === 'exam-screen') {
        const pin = inputs.pin.value || localStorage.getItem('recit_exam_pin');
        socket.emit('relay-event', { pin, event: 'visibility-violation', data: { socketId: socket.id } });
        document.getElementById('exam-screen').classList.add('blur-mitigation');
        startPenalty();
    }
});

window.addEventListener('beforeunload', (e) => {
    if (currentScreen === 'exam-screen' && !isUnloading) {
        const msg = 'Are you sure you want to leave? Your exam progress may be affected.';
        e.returnValue = msg;
        return msg;
    }
    isUnloading = true;
});

// Mobile Edge-Swipe Warning
document.addEventListener('touchstart', (e) => {
    if (currentScreen !== 'exam-screen') return;
    const touch = e.touches[0];
    const screenHeight = window.innerHeight;
    const threshold = 50; // pixels from edge

    if (touch.clientY < threshold || touch.clientY > screenHeight - threshold) {
        const warning = document.getElementById('edge-warning');
        if (warning) {
            warning.classList.add('visible');
            setTimeout(() => warning.classList.remove('visible'), 2000);
        }
    }
}, { passive: true });

function startPenalty() {
    antiCheat.overlay.classList.add('active');
    antiCheat.resumeBtn.disabled = true;
    penaltySecondsLeft = PENALTY_SECONDS;
    
    // Add timer text if not exists
    let timerEl = document.querySelector('.penalty-timer');
    if (!timerEl) {
        timerEl = document.createElement('span');
        timerEl.className = 'penalty-timer';
        antiCheat.resumeBtn.parentNode.appendChild(timerEl);
    }

    const updateTimer = () => {
        if (penaltySecondsLeft > 0) {
            antiCheat.resumeBtn.textContent = `Wait (${penaltySecondsLeft}s)`;
            timerEl.textContent = `You switched windows. Security penalty active.`;
            penaltySecondsLeft--;
            penaltyTimer = setTimeout(updateTimer, 1000);
        } else {
            antiCheat.resumeBtn.disabled = false;
            antiCheat.resumeBtn.textContent = 'Resume Exam';
            timerEl.textContent = '';
        }
    };

    if (penaltyTimer) clearTimeout(penaltyTimer);
    updateTimer();
}

antiCheat.resumeBtn.addEventListener('click', () => {
    antiCheat.overlay.classList.remove('active');
    document.getElementById('exam-screen').classList.remove('blur-mitigation');
});

// Persistence & Auto-Join
function saveSession(pin, name) {
    if (pin) localStorage.setItem('recit_exam_pin', pin);
    if (name) localStorage.setItem('recit_exam_name', name);
}

function clearSession() {
    localStorage.removeItem('recit_exam_pin');
    localStorage.removeItem('recit_exam_name');
}

window.addEventListener('load', () => {
    const savedPin = localStorage.getItem('recit_exam_pin');
    const savedName = localStorage.getItem('recit_exam_name');

    if (savedPin && savedName) {
        console.log('🔄 Attempting auto-rejoin for:', savedName);
        studentName = savedName;
        socket.emit('join-session', { pin: savedPin, name: savedName });
        inputs.error.textContent = 'Reconnecting...';
// Connectivity Handlers
socket.on('disconnect', (reason) => {
    console.warn('🔌 Disconnected:', reason);
    const indicator = document.getElementById('conn-status');
    if (indicator) {
        indicator.textContent = 'Connection Lost - Reconnecting...';
        indicator.className = 'status-badge disconnected';
    }
});

socket.on('reconnect', (attemptNumber) => {
    console.log('🔄 Reconnected after', attemptNumber, 'attempts');
    const indicator = document.getElementById('conn-status');
    if (indicator) {
        indicator.textContent = 'Connected';
        indicator.className = 'status-badge connected';
        setTimeout(() => { indicator.className = 'status-badge hidden'; }, 3000);
    }

    // Auto-rejoin if we were in an exam
    const savedPin = localStorage.getItem('recit_exam_pin');
    const savedName = localStorage.getItem('recit_exam_name');
    if (savedPin && savedName && (currentScreen === 'exam-screen' || currentScreen === 'waiting-screen')) {
        socket.emit('join-session', { pin: savedPin, name: savedName });
    }
});

socket.on('connect_error', (error) => {
    const indicator = document.getElementById('conn-status');
    if (indicator && currentScreen !== 'login-screen') {
        indicator.textContent = 'Connecting...';
        indicator.className = 'status-badge reconnecting';
    }
});
        inputs.joinBtn.disabled = true;
    }
});

