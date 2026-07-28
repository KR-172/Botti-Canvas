const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
document.documentElement.setAttribute('data-theme', tg.colorScheme || 'dark');

const urlParams = new URLSearchParams(window.location.search);

// Get the actual chat or user ID from Telegram's native app context
const initData = tg.initDataUnsafe || {};
const realChatId = initData.chat?.id || initData.user?.id || 'debug_chat';

// Use URL param if provided, otherwise fallback to the real Telegram ID
let chatId = urlParams.get('chat_id') || realChatId.toString();

// --- SHARED CANVAS LOGIC ---
// If the chat is one of these two groups, force them to use the same database path
const sharedGroups = ['-1002348820970', '-1002711105429'];
if (sharedGroups.includes(chatId)) {
    chatId = 'shared_group_canvas';
}

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
let cameraZoom = 1;
let initialPinchDistance = null;
let lastPinchCenter = null;

// Firebase State
let knownLines = new Map();
let knownNotes = new Map();

// UI Elements
const toolPen = document.getElementById('tool-pen');
const toolEraser = document.getElementById('tool-eraser');
const toolPan = document.getElementById('tool-pan');
const colorWheel = document.getElementById('color-wheel');
const addNoteBtn = document.getElementById('add-note-btn');
const photoBtn = document.getElementById('photo-btn');
const photoUpload = document.getElementById('photo-upload');
const undoBtn = document.getElementById('undo-btn');

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
    
    // Handle Pinch Start
    if (e.touches && e.touches.length === 2) {
        initialPinchDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        lastPinchCenter = {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };
        isDrawing = false;
        isPanning = false;
        return;
    }
    if (e.touches && e.touches.length > 1) return;
    
    const pos = getPointerPos(e);
    
    if (currentTool === 'pan') {
        isPanning = true;
        lastPanPos = pos;
        return;
    }
    
    isDrawing = true;
    lastPos = { x: (pos.x - cameraX) / cameraZoom, y: (pos.y - cameraY) / cameraZoom }; // Save in World Coordinates
    currentLine = [{ x: lastPos.x, y: lastPos.y }];
    
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y); // Draw on screen coordinates
}

function draw(e) {
    // Handle Pinch Zoom
    if (e.touches && e.touches.length === 2) {
        e.preventDefault();
        if (initialPinchDistance && lastPinchCenter) {
            const currentPinchDistance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const pinchRatio = currentPinchDistance / initialPinchDistance;
            
            const pinchCenterX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const pinchCenterY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

            // Pan based on movement of the pinch center
            cameraX += pinchCenterX - lastPinchCenter.x;
            cameraY += pinchCenterY - lastPinchCenter.y;

            // Zoom around the new center
            cameraX = pinchCenterX - (pinchCenterX - cameraX) * pinchRatio;
            cameraY = pinchCenterY - (pinchCenterY - cameraY) * pinchRatio;
            cameraZoom *= pinchRatio;
            
            initialPinchDistance = currentPinchDistance;
            lastPinchCenter = { x: pinchCenterX, y: pinchCenterY };

            notesContainer.style.transform = `translate(${cameraX}px, ${cameraY}px) scale(${cameraZoom})`;
            renderAll();
        }
        return;
    }

    if (isPanning) {
        e.preventDefault();
        const pos = getPointerPos(e);
        const dx = pos.x - lastPanPos.x;
        const dy = pos.y - lastPanPos.y;
        
        cameraX += dx;
        cameraY += dy;
        lastPanPos = pos;
        
        notesContainer.style.transform = `translate(${cameraX}px, ${cameraY}px) scale(${cameraZoom})`;
        renderAll();
        return;
    }
    
    if (!isDrawing) return;
    e.preventDefault();
    const pos = getPointerPos(e);
    const worldPos = { x: (pos.x - cameraX) / cameraZoom, y: (pos.y - cameraY) / cameraZoom };
    
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = currentTool === 'eraser' ? document.body.style.backgroundColor || '#1a1a2e' : currentColor;
    ctx.lineWidth = (currentTool === 'eraser' ? 30 : 5) * cameraZoom;
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
    initialPinchDistance = null;
    lastPinchCenter = null;
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

// Mouse Wheel Zoom
canvas.addEventListener('wheel', (e) => {
    if (e.target.closest('.toolbar') || noteModal.style.display === 'block') return;
    e.preventDefault();
    
    const zoomFactor = 1.05;
    const direction = e.deltaY > 0 ? (1 / zoomFactor) : zoomFactor;
    
    const pointerX = e.clientX;
    const pointerY = e.clientY;
    
    cameraX = pointerX - (pointerX - cameraX) * direction;
    cameraY = pointerY - (pointerY - cameraY) * direction;
    cameraZoom *= direction;
    
    notesContainer.style.transform = `translate(${cameraX}px, ${cameraY}px) scale(${cameraZoom})`;
    renderAll();
}, { passive: false });

// Firebase Rendering
function renderAll() {
    if (!knownLines) return;
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
                    knownNotes.set(id, note);
                    renderNoteDOM(id, note);
                } else {
                    knownNotes.set(id, note);
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
    ctx.moveTo(line.points[0].x * cameraZoom + cameraX, line.points[0].y * cameraZoom + cameraY); // Apply camera offset
    
    if (line.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = 30 * cameraZoom;
    } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 5 * cameraZoom;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    for (let i = 1; i < line.points.length; i++) {
        ctx.lineTo(line.points[i].x * cameraZoom + cameraX, line.points[i].y * cameraZoom + cameraY); // Apply camera offset
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
        x: (Math.random() * (window.innerWidth - 200) + 20 - cameraX) / cameraZoom, // Drop in world space
        y: (Math.random() * (window.innerHeight - 300) + 50 - cameraY) / cameraZoom, // Drop in world space
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
        const dx = (pos.x - startX) / cameraZoom;
        const dy = (pos.y - startY) / cameraZoom;
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
        const base64Image = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target.result.split(',')[1]);
            reader.onerror = (error) => reject(error);
            reader.readAsDataURL(file);
        });
        
        const res = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64Image })
        });
        
        const data = await res.json();
        
        if (res.ok && data.url) {
            const noteId = Date.now().toString();
            const newPhotoNote = {
                type: 'photo',
                url: data.url,
                x: (Math.random() * (window.innerWidth - 200) + 20 - cameraX) / cameraZoom, // Drop in world space
                y: (Math.random() * (window.innerHeight - 300) + 50 - cameraY) / cameraZoom, // Drop in world space
                z: 10,
                author: user.first_name
            };
            
            await fetch(`${CANVAS_DB}/notes/${noteId}.json`, {
                method: 'PUT',
                body: JSON.stringify(newPhotoNote)
            });
        } else {
            alert("Upload failed. Error: " + (data.error || "Unknown"));
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

// Undo Logic
const undoLastAction = async () => {
    let mostRecentLine = null;
    let mostRecentLineId = null;
    let maxLineTime = 0;

    knownLines.forEach((line, id) => {
        if (line.user === user.first_name && line.timestamp > maxLineTime) {
            maxLineTime = line.timestamp;
            mostRecentLine = line;
            mostRecentLineId = id;
        }
    });

    let mostRecentNoteId = null;
    let maxNoteTime = 0;

    knownNotes.forEach((note, id) => {
        if (note.author === user.first_name) {
            const time = parseInt(id); // Since we use Date.now().toString() for notes
            if (time > maxNoteTime) {
                maxNoteTime = time;
                mostRecentNoteId = id;
            }
        }
    });

    if (maxLineTime === 0 && maxNoteTime === 0) {
        alert("Nothing to undo!");
        return;
    }

    if (maxLineTime > maxNoteTime) {
        // Delete line
        knownLines.delete(mostRecentLineId);
        renderAll();
        await fetch(`${CANVAS_DB}/lines/${mostRecentLineId}.json`, { method: 'DELETE' });
    } else {
        // Delete note
        document.getElementById(`note-${mostRecentNoteId}`)?.remove();
        knownNotes.delete(mostRecentNoteId);
        await fetch(`${CANVAS_DB}/notes/${mostRecentNoteId}.json`, { method: 'DELETE' });
    }
};

if (undoBtn) undoBtn.onclick = undoLastAction;

// Start polling

resizeCanvas(); // Initial setup
pollFirebase();
