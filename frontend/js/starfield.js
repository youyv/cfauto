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

    function draw(ts) {
        try {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

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

        } catch(e) { console.error('[Starfield] draw error:', e); starAnimId = null; return; }
        starAnimId = requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
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
        document.body.style.removeProperty('background');
        document.getElementById('theme_btn').innerText = '☀️';
        btn.style.transform = 'rotate(-180deg)';
        setTimeout(() => { btn.style.transform = ''; }, 400);
        stopStarfield();
        localStorage.setItem('worker_theme', 'light'); styleToggles(false);
    } else {
        html.setAttribute('data-theme', 'dark');
        document.body.style.setProperty('background', '#040914', 'important');
        document.getElementById('theme_btn').innerText = '🌙';
        btn.style.transform = 'rotate(180deg)';
        setTimeout(() => { btn.style.transform = ''; }, 400);
        initStarfield();
        localStorage.setItem('worker_theme', 'dark'); styleToggles(true);
    }
}

function applyTheme() {
    const saved = localStorage.getItem('worker_theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    // 手动设置优先; 无手动设置时跟随系统
    const shouldDark = saved === 'dark' || (saved !== 'light' && prefersDark);
    if (shouldDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.style.setProperty('background', '#040914', 'important');
        document.getElementById('theme_btn').innerText = '🌙';
        initStarfield();
    }
}
applyTheme();
function styleToggles(isDark) {
    document.querySelectorAll('.toggle-checkbox').forEach(function(cb) {
        cb.style.setProperty('background', '#fff', 'important');
        cb.style.setProperty('border-color', isDark ? (cb.checked ? '#a78bfa' : '#6b7280') : '', 'important');
    });
    document.querySelectorAll('.toggle-label').forEach(function(l) {
        var cb = l.parentElement.querySelector('.toggle-checkbox');
        if (!cb) return;
        if (isDark) {
            l.style.setProperty('background-color', cb.checked ? '#a78bfa' : '#374151', 'important');
        } else {
            l.style.setProperty('background-color', cb.checked ? '#8b5cf6' : '#d1d5db', 'important');
        }
    });
}
// 开关状态变化时自动刷新样式
document.addEventListener('change', function(e) {
    if (e.target.classList.contains('toggle-checkbox')) {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        styleToggles(isDark);
    }
});


// 标签页不可见时暂停星空动画以节省性能
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopStarfield();
    } else {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDark) initStarfield(); styleToggles(isDark);
    }
});

// 监听系统主题变化（仅在无手动覆盖时生效）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const saved = localStorage.getItem('worker_theme');
    if (!saved) { // 无手动设置时跟随系统
        if (e.matches) {
            document.documentElement.setAttribute('data-theme', 'dark');
            document.body.style.setProperty('background', '#040914', 'important');
            document.getElementById('theme_btn').innerText = '🌙';
            initStarfield();
        } else {
            document.documentElement.removeAttribute('data-theme');
            document.body.style.removeProperty('background');
            document.getElementById('theme_btn').innerText = '☀️';
            stopStarfield();
        }
    }
});

// 应用入口（init 定义于 state.js，在所有 JS 文件拼接后调用）
init();