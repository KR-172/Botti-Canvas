const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
document.documentElement.setAttribute('data-theme', tg.colorScheme || 'dark');

const urlParams = new URLSearchParams(window.location.search);
const chatId = urlParams.get('chat_id') || 'debug_chat';
const user = tg.initDataUnsafe?.user || { id: 123, first_name: 'Debug User' };

// We will use the same Firebase database URL.
const FIREBASE_URL = 'https://gen-lang-client-0401082963-default-rtdb.europe-west1.firebasedatabase.app';
const CANVAS_DB = `${FIREBASE_URL}/canvas/chat_${chatId}`;

// Setup Canvas
const canvas = document.getElementById('drawing-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const notesContainer = document.getElementById('notes-container');

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Drawing State
let isDrawing = false;
let currentTool = 'pen';
let currentColor = '#ff3b30';
let currentLine = [];
let lastPos = null;

// UI Elements
const toolPen = document.getElementById('tool-pen');
const toolEraser = document.getElementById('tool-eraser');
const colorBtns = document.querySelectorAll('.color-btn');
const clearBtn = document.getElementById('clear-btn');
const addNoteBtn = document.getElementById('add-note-btn');
const photoBtn = document.getElementById('photo-btn');
const photoUpload = document.getElementById('photo-upload');

// Modal Elements
const noteModal = document.getElementById('note-modal');
const closeModal = document.getElementById('close-modal');
const saveNoteBtn = document.getElementById('save-note-btn');
const noteText = document.getElementById('note-text');
const noteColorBtns = document.querySelectorAll('.note-color-btn');
let selectedNoteColor = '#ffeb3b';

// Tools logic
toolPen.onclick = () => { currentTool = 'pen'; toolPen.classList.add('active'); toolEraser.classList.remove('active'); };
toolEraser.onclick = () => { currentTool = 'eraser'; toolEraser.classList.add('active'); toolPen.classList.remove('active'); };

colorBtns.forEach(btn => {
    btn.onclick = () => {
        colorBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentColor = btn.dataset.color;
        toolPen.click(); // Auto switch back to pen
    };
});

noteColorBtns.forEach(btn => {
    btn.onclick = () => {
        noteColorBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedNoteColor = btn.dataset.color;
    };
});

// Canvas Drawing Logic
function getPointerPos(e) {
    if (e.touches && e.touches.length > 0) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
}

function startDrawing(e) {
    if (e.target.closest('.toolbar') || e.target.closest('.sticky-note') || noteModal.style.display === 'block') return;
    isDrawing = true;
    lastPos = getPointerPos(e);
    currentLine = [{ x: lastPos.x, y: lastPos.y }];
    ctx.beginPath();
    ctx.moveTo(lastPos.x, lastPos.y);
}

function draw(e) {
    if (!isDrawing) return;
    e.preventDefault(); // prevent scrolling
    const pos = getPointerPos(e);
    
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = currentTool === 'eraser' ? document.body.style.backgroundColor || '#1a1a2e' : currentColor;
    ctx.lineWidth = currentTool === 'eraser' ? 30 : 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // For eraser, use destination-out to actually clear pixels, or just draw background color.
    if (currentTool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
        ctx.globalCompositeOperation = 'source-over';
    }
    
    ctx.stroke();
    
    currentLine.push({ x: pos.x, y: pos.y });
    lastPos = pos;
}

async function stopDrawing() {
    if (!isDrawing) return;
    isDrawing = false;
    ctx.closePath();
    ctx.globalCompositeOperation = 'source-over';
    
    if (currentLine.length > 1) {
        const lineData = {
            points: currentLine,
            color: currentColor,
            tool: currentTool,
            user: user.first_name,
            timestamp: Date.now()
        };
        // Fire & Forget to Firebase
        fetch(`${CANVAS_DB}/lines.json`, {
            method: 'POST',
            body: JSON.stringify(lineData)
        });
    }
    currentLine = [];
}

canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
window.addEventListener('mouseup', stopDrawing);

canvas.addEventListener('touchstart', startDrawing, { passive: false });
canvas.addEventListener('touchmove', draw, { passive: false });
window.addEventListener('touchend', stopDrawing);

// Firebase Rendering (Polling for simplicity without full SDK, though EventSource is better. We will use short polling for demo)
let lastLineTime = 0;
let knownLines = new Set();
let knownNotes = new Set();

async function pollFirebase() {
    try {
        const res = await fetch(`${CANVAS_DB}.json`);
        const data = await res.json();
        
        if (!data) return;

        // Render Lines
        if (data.lines) {
            Object.entries(data.lines).forEach(([id, line]) => {
                if (!knownLines.has(id)) {
                    knownLines.add(id);
                    // Don't draw our own lines that we just drew to prevent lag
                    if (Date.now() - line.timestamp > 2000 || line.user !== user.first_name) {
                        drawLineData(line);
                    }
                }
            });
        } else {
            // Someone cleared it
            if (knownLines.size > 0) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                knownLines.clear();
            }
        }

        // Render Notes
        if (data.notes) {
            Object.entries(data.notes).forEach(([id, note]) => {
                if (!knownNotes.has(id)) {
                    knownNotes.add(id);
                    renderNoteDOM(id, note);
                } else {
                    // Update existing note position
                    const noteEl = document.getElementById(`note-${id}`);
                    if (noteEl && !noteEl.isDragging) {
                        noteEl.style.left = note.x + 'px';
                        noteEl.style.top = note.y + 'px';
                        noteEl.style.zIndex = note.z || 10;
                    }
                }
            });
            // Handle deleted notes
            document.querySelectorAll('.sticky-note').forEach(el => {
                const id = el.id.replace('note-', '');
                if (!data.notes[id]) {
                    el.remove();
                    knownNotes.delete(id);
                }
            });
        } else {
            notesContainer.innerHTML = '';
            knownNotes.clear();
        }
        
    } catch (e) {
        console.error(e);
    }
    setTimeout(pollFirebase, 1500);
}

function drawLineData(line) {
    if (!line.points || line.points.length < 2) return;
    
    ctx.beginPath();
    ctx.moveTo(line.points[0].x, line.points[0].y);
    
    if (line.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = 30;
    } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 5;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    for (let i = 1; i < line.points.length; i++) {
        ctx.lineTo(line.points[i].x, line.points[i].y);
    }
    ctx.stroke();
    ctx.closePath();
    ctx.globalCompositeOperation = 'source-over';
}

// Clear Canvas
clearBtn.onclick = async () => {
    if (confirm("Are you sure you want to erase the whole canvas and all notes?")) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        notesContainer.innerHTML = '';
        knownLines.clear();
        knownNotes.clear();
        await fetch(`${CANVAS_DB}.json`, { method: 'DELETE' });
    }
};

// Notes Logic
addNoteBtn.onclick = () => {
    noteText.value = '';
    noteModal.style.display = 'block';
};
closeModal.onclick = () => noteModal.style.display = 'none';

saveNoteBtn.onclick = async () => {
    const text = noteText.value.trim();
    if (!text) return;
    
    const noteId = Date.now().toString();
    const newNote = {
        text: text,
        color: selectedNoteColor,
        x: Math.random() * (window.innerWidth - 200) + 20,
        y: Math.random() * (window.innerHeight - 300) + 50,
        z: 10,
        author: user.first_name
    };
    
    noteModal.style.display = 'none';
    
    await fetch(`${CANVAS_DB}/notes/${noteId}.json`, {
        method: 'PUT',
        body: JSON.stringify(newNote)
    });
};

function renderNoteDOM(id, note) {
    const el = document.createElement('div');
    el.className = 'sticky-note';
    el.id = `note-${id}`;
    el.style.backgroundColor = note.color;
    el.style.left = note.x + 'px';
    el.style.top = note.y + 'px';
    el.style.zIndex = note.z || 10;
    
    if (note.type === 'photo') {
        el.classList.add('photo-note');
        el.innerHTML = `
            <button class="note-delete" onclick="deleteNote('${id}')">✖</button>
            <div class="note-author">${note.author}</div>
            <img src="${note.url}" alt="Pinned Photo">
        `;
    } else {
        el.innerHTML = `
            <button class="note-delete" onclick="deleteNote('${id}')">✖</button>
            <div class="note-author">${note.author}</div>
            <div class="note-content">${note.text.replace(/\\n/g, '<br>')}</div>
        `;
    }
    
    makeDraggable(el, id);
    notesContainer.appendChild(el);
}

window.deleteNote = async (id) => {
    document.getElementById(`note-${id}`).remove();
    knownNotes.delete(id);
    await fetch(`${CANVAS_DB}/notes/${id}.json`, { method: 'DELETE' });
};

// Draggable Notes
let highestZ = 10;
function makeDraggable(el, id) {
    let isDragging = false;
    let startX, startY, initialX, initialY;
    
    function startDrag(e) {
        if (e.target.classList.contains('note-delete')) return;
        isDragging = true;
        el.isDragging = true;
        
        highestZ++;
        el.style.zIndex = highestZ;
        
        const pos = getPointerPos(e);
        startX = pos.x;
        startY = pos.y;
        initialX = parseFloat(el.style.left);
        initialY = parseFloat(el.style.top);
    }
    
    function drag(e) {
        if (!isDragging) return;
        e.preventDefault();
        const pos = getPointerPos(e);
        const dx = pos.x - startX;
        const dy = pos.y - startY;
        el.style.left = (initialX + dx) + 'px';
        el.style.top = (initialY + dy) + 'px';
    }
    
    function stopDrag() {
        if (!isDragging) return;
        isDragging = false;
        el.isDragging = false;
        
        // Sync new position
        fetch(`${CANVAS_DB}/notes/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({
                x: parseFloat(el.style.left),
                y: parseFloat(el.style.top),
                z: highestZ
            })
        });
    }
    
    el.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', drag);
    window.addEventListener('mouseup', stopDrag);
    
    el.addEventListener('touchstart', startDrag, { passive: false });
    window.addEventListener('touchmove', drag, { passive: false });
    window.addEventListener('touchend', stopDrag);
}

// Photo Upload Logic
photoBtn.onclick = () => {
    photoUpload.click();
};

photoUpload.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    // Change button state
    const originalText = photoBtn.innerText;
    photoBtn.innerText = "⏳ Uploading...";
    photoBtn.disabled = true;
    
    try {
        const formData = new FormData();
        formData.append('file', file);
        
        const res = await fetch('https://telegra.ph/upload', {
            method: 'POST',
            body: formData
        });
        
        const data = await res.json();
        
        if (data && data[0] && data[0].src) {
            const imageUrl = 'https://telegra.ph' + data[0].src;
            
            const noteId = Date.now().toString();
            const newPhotoNote = {
                type: 'photo',
                url: imageUrl,
                x: Math.random() * (window.innerWidth - 200) + 20,
                y: Math.random() * (window.innerHeight - 300) + 50,
                z: 10,
                author: user.first_name
            };
            
            await fetch(`${CANVAS_DB}/notes/${noteId}.json`, {
                method: 'PUT',
                body: JSON.stringify(newPhotoNote)
            });
        } else {
            alert("Upload failed. Telegram might have rejected the image.");
        }
    } catch (err) {
        console.error("Upload error:", err);
        alert("Failed to upload image. Please try again.");
    } finally {
        photoBtn.innerText = originalText;
        photoBtn.disabled = false;
        photoUpload.value = '';
    }
};

// Start polling
pollFirebase();
