// ===== 星空主题引擎 (Premium) =====

let starAnimId = null;
let nebulaPhase = 0;

function initStarfield() {
    try {
    const canvas = document.getElementById('starfield');
    if (!canvas) { console.warn('[Starfield] canvas not found'); return; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { console.warn('[Starfield] 2d context null'); return; }
    let stars = [], shootingStars = [];

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    function createStars() {
        stars = [];
        const count = Math.floor((canvas.width * canvas.height) / 1500);
        const palette = ['#ffffff', '#c4b5fd', '#93c5fd', '#fcd34d', '#a5b4fc', '#fbbf24', '#e9d5ff', '#bfdbfe'];
        for (let i = 0; i < count; i++) {
            stars.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                r: Math.random() * 1.8 + 0.2,
                alpha: Math.random(),
                delta: (Math.random() * 0.018 + 0.002) * (Math.random() > 0.5 ? 1 : -1),
                color: palette[Math.floor(Math.random() * palette.length)]
            });
        }
        console.log('[Starfield] stars created:', stars.length, 'canvas:', canvas.width+'x'+canvas.height);
    }
    createStars();
    window.addEventListener('resize', createStars);

    function maybeShootingStar() {
        if (Math.random() < 0.012 && shootingStars.length < 4) {
            shootingStars.push({
                x: Math.random() * canvas.width * 0.7,
                y: Math.random() * canvas.height * 0.3,
                len: Math.random() * 100 + 50,
                speed: Math.random() * 7 + 5,
                alpha: 1
            });
        }
    }

    let frameCount = 0;
    function draw(ts) {
        try {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, 0, canvas.width/2, canvas.height/2, canvas.width*0.7);
        grad.addColorStop(0, '#0f172a');
        grad.addColorStop(0.4, '#0c1322');
        grad.addColorStop(0.8, '#080e1a');
        grad.addColorStop(1, '#020617');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // DIAG: 四角醒目测试圆 — 如果看不到说明 canvas 被遮盖
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ff0000'; ctx.beginPath(); ctx.arc(40,40,20,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#00ff00'; ctx.beginPath(); ctx.arc(canvas.width-40,40,20,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#0000ff'; ctx.beginPath(); ctx.arc(40,canvas.height-40,20,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ffff00'; ctx.beginPath(); ctx.arc(canvas.width-40,canvas.height-40,20,0,Math.PI*2); ctx.fill();
        ctx.font = 'bold 24px sans-serif'; ctx.fillStyle = '#ffffff';
        ctx.fillText('CANVAS OK', canvas.width/2-80, canvas.height/2);

        nebulaPhase = (nebulaPhase + 0.003) % (Math.PI * 2);
        const pulse = 0.5 + 0.5 * Math.sin(nebulaPhase);

        const nebula1 = ctx.createRadialGradient(canvas.width * 0.2, canvas.height * 0.3, 0, canvas.width * 0.2, canvas.height * 0.3, 350);
        nebula1.addColorStop(0, 'rgba(139,92,246,'+(0.025 + pulse * 0.015)+')');
        nebula1.addColorStop(0.5, 'rgba(139,92,246,'+(0.01 + pulse * 0.005)+')');
        nebula1.addColorStop(1, 'transparent');
        ctx.fillStyle = nebula1;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const nebula2 = ctx.createRadialGradient(canvas.width * 0.8, canvas.height * 0.7, 0, canvas.width * 0.8, canvas.height * 0.7, 280);
        nebula2.addColorStop(0, 'rgba(59,130,246,'+(0.02 + pulse * 0.012)+')');
        nebula2.addColorStop(0.5, 'rgba(59,130,246,'+(0.008 + pulse * 0.004)+')');
        nebula2.addColorStop(1, 'transparent');
        ctx.fillStyle = nebula2;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const nebula3 = ctx.createRadialGradient(canvas.width * 0.5, canvas.height * 0.5, 0, canvas.width * 0.5, canvas.height * 0.5, 400);
        nebula3.addColorStop(0, 'rgba(251,191,36,'+(0.008 + pulse * 0.006)+')');
        nebula3.addColorStop(1, 'transparent');
        ctx.fillStyle = nebula3;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        for (const s of stars) {
            s.alpha += s.delta;
            if (s.alpha <= 0.08 || s.alpha >= 1) s.delta = -s.delta;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fillStyle = s.color;
            ctx.globalAlpha = Math.max(0.08, Math.min(1, s.alpha));
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        maybeShootingStar();
        shootingStars = shootingStars.filter(function(m) {
            m.x += m.speed; m.y += m.speed * 0.6; m.alpha -= 0.012;
            if (m.alpha <= 0) return false;
            ctx.save();
            ctx.globalAlpha = m.alpha;
            var g = ctx.createLinearGradient(m.x, m.y, m.x - m.len, m.y - m.len * 0.6);
            g.addColorStop(0, '#ffffff');
            g.addColorStop(0.1, '#e9d5ff');
            g.addColorStop(1, 'transparent');
            ctx.strokeStyle = g;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(m.x, m.y);
            ctx.lineTo(m.x - m.len, m.y - m.len * 0.6);
            ctx.stroke();
            ctx.restore();
            return true;
        });

        frameCount++;
        if (frameCount === 1) console.log('[Starfield] first frame rendered, stars:', stars.length);
        } catch(e) { console.error('[Starfield] draw error:', e); starAnimId = null; return; }
        starAnimId = requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    console.log('[Starfield] init complete');
    } catch(e) { console.error('[Starfield] init error:', e); }
}

function stopStarfield() {
    if (starAnimId) { cancelAnimationFrame(starAnimId); starAnimId = null; }
}

function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    const btn = document.getElementById('theme_btn');
    if (isDark) {
        html.removeAttribute('data-theme');
        document.body.style.background = '';
        btn.innerText = '☀️';
        btn.style.transform = 'rotate(-180deg)';
        setTimeout(() => { btn.style.transform = ''; }, 400);
        stopStarfield();
        localStorage.setItem('worker_theme', 'light');
    } else {
        html.setAttribute('data-theme', 'dark');
        document.body.style.background = 'transparent';
        btn.innerText = '🌙';
        btn.style.transform = 'rotate(180deg)';
        setTimeout(() => { btn.style.transform = ''; }, 400);
        initStarfield();
        localStorage.setItem('worker_theme', 'dark');
    }
}

function applyTheme() {
    const saved = localStorage.getItem('worker_theme');
    if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.style.background = 'transparent';
        document.getElementById('theme_btn').innerText = '🌙';
        initStarfield();
    }
}
applyTheme();

// 应用入口（init 定义于 state.js，在所有 JS 文件拼接后调用）
init();