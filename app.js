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
    if (typeof renderAll === 'function') {
        renderAll();
    }
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Drawing & Camera State
let isDrawing = false;
let isPanning = false;
let currentTool = 'pen';
let currentColor = '#ff3b30';
let currentLine = [];
let lastPos = null;
let lastPanPos = null;

let cameraX = 0;
let cameraY = 0;

// UI Elements
const toolPen = document.getElementById('tool-pen');
const toolEraser = document.getElementById('tool-eraser');
const toolPan = document.getElementById('tool-pan');
const colorWheel = document.getElementById('color-wheel');
const addNoteBtn = document.getElementById('add-note-btn');
const photoBtn = document.getElementById('photo-btn');
const photoUpload = document.getElementById('photo-upload');

// Modal Elements
const noteModal = document.getElementById('note-modal');
const closeModal = document.getElementById('close-modal');
const saveNoteBtn = document.getElementById('save-note-btn');
const noteText = document.getElementById('note-text');
const noteFontSelect = document.getElementById('note-font-select');
const noteColorBtns = document.querySelectorAll('.note-color-btn');
let selectedNoteColor = '#ffeb3b';

// Tools logic
toolPen.onclick = () => { currentTool = 'pen'; toolPen.classList.add('active'); toolEraser.classList.remove('active'); toolPan.classList.remove('active'); canvas.classList.remove('pan-mode'); };
toolEraser.onclick = () => { currentTool = 'eraser'; toolEraser.classList.add('active'); toolPen.classList.remove('active'); toolPan.classList.remove('active'); canvas.classList.remove('pan-mode'); };
toolPan.onclick = () => { currentTool = 'pan'; toolPan.classList.add('active'); toolPen.classList.remove('active'); toolEraser.classList.remove('active'); canvas.classList.add('pan-mode'); };

colorWheel.oninput = (e) => {
    currentColor = e.target.value;
    toolPen.click(); // Auto switch back to pen when picking a color
};

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
    
    const pos = getPointerPos(e);
    
    if (currentTool === 'pan') {
        isPanning = true;
        lastPanPos = pos;
        return;
    }
    
    isDrawing = true;
    lastPos = { x: pos.x - cameraX, y: pos.y - cameraY }; // Save in World Coordinates
    currentLine = [{ x: lastPos.x, y: lastPos.y }];
    
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y); // Draw on screen coordinates
}

function draw(e) {
    if (isPanning) {
        e.preventDefault();
        const pos = getPointerPos(e);
        const dx = pos.x - lastPanPos.x;
        const dy = pos.y - lastPanPos.y;
        
        cameraX += dx;
        cameraY += dy;
        lastPanPos = pos;
        
        notesContainer.style.transform = `translate(${cameraX}px, ${cameraY}px)`;
        renderAll();
        return;
    }
    
    if (!isDrawing) return;
    e.preventDefault();
    const pos = getPointerPos(e);
    const worldPos = { x: pos.x - cameraX, y: pos.y - cameraY };
    
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = currentTool === 'eraser' ? document.body.style.backgroundColor || '#1a1a2e' : currentColor;
    ctx.lineWidth = currentTool === 'eraser' ? 30 : 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (currentTool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
        ctx.globalCompositeOperation = 'source-over';
    }
    
    ctx.stroke();
    
    currentLine.push({ x: worldPos.x, y: worldPos.y });
    lastPos = worldPos;
}

async function stopDrawing() {
    if (isPanning) {
        isPanning = false;
        return;
    }
    
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

// Firebase Rendering
let knownLines = new Map();
let knownNotes = new Set();

function renderAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    knownLines.forEach(line => {
        drawLineData(line);
    });
}

async function pollFirebase() {
    try {
        const res = await fetch(`${CANVAS_DB}.json`);
        const data = await res.json();
        
        if (!data) {
            // If DB is empty, clear local and keep polling
            if (knownLines.size > 0) {
                knownLines.clear();
                renderAll();
            }
            if (knownNotes.size > 0) {
                notesContainer.innerHTML = '';
                knownNotes.clear();
            }
            setTimeout(pollFirebase, 1500);
            return;
        }

        // Render Lines
        let shouldRender = false;
        if (data.lines) {
            Object.entries(data.lines).forEach(([id, line]) => {
                if (!knownLines.has(id)) {
                    knownLines.set(id, line);
                    shouldRender = true;
                }
            });
            if (shouldRender) renderAll();
        } else {
            if (knownLines.size > 0) {
                knownLines.clear();
                renderAll();
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
    ctx.moveTo(line.points[0].x + cameraX, line.points[0].y + cameraY); // Apply camera offset
    
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
        ctx.lineTo(line.points[i].x + cameraX, line.points[i].y + cameraY); // Apply camera offset
    }
    ctx.stroke();
    ctx.closePath();
    ctx.globalCompositeOperation = 'source-over';
}

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
        font: noteFontSelect.value,
        x: Math.random() * (window.innerWidth - 200) + 20 - cameraX, // Drop in world space
        y: Math.random() * (window.innerHeight - 300) + 50 - cameraY, // Drop in world space
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
        const fontClass = note.font || 'font-inter';
        el.innerHTML = `
            <button class="note-delete" onclick="deleteNote('${id}')">✖</button>
            <div class="note-author">${note.author}</div>
            <div class="note-content ${fontClass}">${note.text.replace(/\\n/g, '<br>')}</div>
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
                x: Math.random() * (window.innerWidth - 200) + 20 - cameraX, // Drop in world space
                y: Math.random() * (window.innerHeight - 300) + 50 - cameraY, // Drop in world space
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
