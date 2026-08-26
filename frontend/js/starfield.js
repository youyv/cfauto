// ===== 星空主题引擎 (Premium) =====

let starAnimId = null;
let nebulaPhase = 0;
/** 已初始化标记：initStarfield 会被 toggleTheme / visibilitychange / 系统主题变化多次调用，
 *  此前每次都会新增 resize 监听并额外启动一个 rAF 循环（越切越卡）。现在只建一次场景。 */
let starScene = null;

function buildStarScene() {
    const canvas = document.getElementById('starfield');
    if (!canvas) { console.warn('[Starfield] canvas not found'); return null; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { console.warn('[Starfield] 2d context null'); return null; }

    const scene = { canvas, ctx, stars: [], shootingStars: [] };

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        createStars();
    }
    function createStars() {
        scene.stars = [];
        const count = Math.floor((canvas.width * canvas.height) / 1500);
        const palette = ['#ffffff', '#c4b5fd', '#93c5fd', '#fcd34d', '#a5b4fc', '#fbbf24', '#e9d5ff', '#bfdbfe'];
        for (let i = 0; i < count; i++) {
            scene.stars.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                r: Math.random() * 1.8 + 0.2,
                alpha: Math.random(),
                delta: (Math.random() * 0.018 + 0.002) * (Math.random() > 0.5 ? 1 : -1),
                color: palette[Math.floor(Math.random() * palette.length)]
            });
        }
    }
    resize();
    // 只注册一次（合并了原来的两个独立 resize 监听）
    window.addEventListener('resize', resize);
    return scene;
}

function initStarfield() {
    try {
        if (starAnimId !== null) return;              // 已在运行
        if (!starScene) starScene = buildStarScene();
        if (!starScene) return;
        const { canvas, ctx } = starScene;

        function maybeShootingStar() {
            if (Math.random() < 0.012 && starScene.shootingStars.length < 4) {
                starScene.shootingStars.push({
                    x: Math.random() * canvas.width * 0.7,
                    y: Math.random() * canvas.height * 0.3,
                    len: Math.random() * 100 + 50,
                    speed: Math.random() * 7 + 5,
                    alpha: 1
                });
            }
        }

        function draw() {
            try {
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                nebulaPhase = (nebulaPhase + 0.003) % (Math.PI * 2);
                const pulse = 0.5 + 0.5 * Math.sin(nebulaPhase);

                const nebula1 = ctx.createRadialGradient(canvas.width * 0.2, canvas.height * 0.3, 0, canvas.width * 0.2, canvas.height * 0.3, 350);
                nebula1.addColorStop(0, 'rgba(139,92,246,' + (0.025 + pulse * 0.015) + ')');
                nebula1.addColorStop(0.5, 'rgba(139,92,246,' + (0.01 + pulse * 0.005) + ')');
                nebula1.addColorStop(1, 'transparent');
                ctx.fillStyle = nebula1;
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                const nebula2 = ctx.createRadialGradient(canvas.width * 0.8, canvas.height * 0.7, 0, canvas.width * 0.8, canvas.height * 0.7, 280);
                nebula2.addColorStop(0, 'rgba(59,130,246,' + (0.02 + pulse * 0.012) + ')');
                nebula2.addColorStop(0.5, 'rgba(59,130,246,' + (0.008 + pulse * 0.004) + ')');
                nebula2.addColorStop(1, 'transparent');
                ctx.fillStyle = nebula2;
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                const nebula3 = ctx.createRadialGradient(canvas.width * 0.5, canvas.height * 0.5, 0, canvas.width * 0.5, canvas.height * 0.5, 400);
                nebula3.addColorStop(0, 'rgba(251,191,36,' + (0.008 + pulse * 0.006) + ')');
                nebula3.addColorStop(1, 'transparent');
                ctx.fillStyle = nebula3;
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                for (const s of starScene.stars) {
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
                starScene.shootingStars = starScene.shootingStars.filter(function (m) {
                    m.x += m.speed; m.y += m.speed * 0.6; m.alpha -= 0.012;
                    if (m.alpha <= 0) return false;
                    ctx.save();
                    ctx.globalAlpha = m.alpha;
                    const g = ctx.createLinearGradient(m.x, m.y, m.x - m.len, m.y - m.len * 0.6);
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
            } catch (e) { console.error('[Starfield] draw error:', e); starAnimId = null; return; }
            starAnimId = requestAnimationFrame(draw);
        }
        starAnimId = requestAnimationFrame(draw);
    } catch (e) { console.error('[Starfield] init error:', e); }
}

function stopStarfield() {
    if (starAnimId) { cancelAnimationFrame(starAnimId); starAnimId = null; }
}

/** 应用暗色/亮色外观（不含 localStorage 写入） */
function setDarkMode(dark) {
    const html = document.documentElement;
    const btn = document.getElementById('theme_btn');
    if (dark) {
        html.setAttribute('data-theme', 'dark');
        document.body.style.setProperty('background', '#040914', 'important');
        if (btn) btn.innerText = '🌙';
        initStarfield();
    } else {
        html.removeAttribute('data-theme');
        document.body.style.removeProperty('background');
        if (btn) btn.innerText = '☀️';
        stopStarfield();
    }
}

function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const btn = document.getElementById('theme_btn');
    setDarkMode(!isDark);
    localStorage.setItem('worker_theme', isDark ? 'light' : 'dark');
    if (btn) {
        btn.style.transform = isDark ? 'rotate(-180deg)' : 'rotate(180deg)';
        setTimeout(() => { btn.style.transform = ''; }, 400);
    }
}

function applyTheme() {
    const saved = localStorage.getItem('worker_theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    // 手动设置优先; 无手动设置时跟随系统
    if (saved === 'dark' || (saved !== 'light' && prefersDark)) setDarkMode(true);
}

// 标签页不可见时暂停星空动画以节省性能
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopStarfield();
    } else if (document.documentElement.getAttribute('data-theme') === 'dark') {
        initStarfield();
    }
});

// 监听系统主题变化（仅在无手动覆盖时生效）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('worker_theme')) setDarkMode(e.matches);
});

// @exports
window.initStarfield = initStarfield;
window.applyTheme = applyTheme;

registerActions({
    toggleTheme: toggleTheme
});

// ===== 应用入口 =====
// 前端已拆为外部 /app.js（defer 加载），此文件是拼接顺序中的最后一个，
// 因此在此启动。defer 保证 DOM 已解析完成；仍做一次保险检查。
function bootApp() {
    applyTheme();
    init();
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp, { once: true });
} else {
    bootApp();
}
