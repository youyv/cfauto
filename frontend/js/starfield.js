// ===== 星空主题引擎 =====

let starAnimId = null;
function initStarfield() {
    const canvas = document.getElementById('starfield');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let stars = [], shootingStars = [];

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    function createStars() {
        stars = [];
        const count = Math.floor((canvas.width * canvas.height) / 3000);
        for (let i = 0; i < count; i++) {
            stars.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                r: Math.random() * 1.5 + 0.3,
                alpha: Math.random(),
                delta: (Math.random() * 0.02 + 0.003) * (Math.random() > 0.5 ? 1 : -1),
                color: ['#ffffff', '#c4b5fd', '#93c5fd', '#fcd34d', '#a5b4fc'][Math.floor(Math.random() * 5)]
            });
        }
    }
    createStars();
    window.addEventListener('resize', createStars);

    function maybeShootingStar() {
        if (Math.random() < 0.008 && shootingStars.length < 3) {
            shootingStars.push({
                x: Math.random() * canvas.width * 0.7,
                y: Math.random() * canvas.height * 0.3,
                len: Math.random() * 80 + 40,
                speed: Math.random() * 6 + 4,
                alpha: 1
            });
        }
    }

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, 0, canvas.width/2, canvas.height/2, canvas.width*0.7);
        grad.addColorStop(0, '#0f172a');
        grad.addColorStop(0.5, '#0c1222');
        grad.addColorStop(1, '#020617');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const nebula = ctx.createRadialGradient(canvas.width * 0.2, canvas.height * 0.3, 0, canvas.width * 0.2, canvas.height * 0.3, 300);
        nebula.addColorStop(0, 'rgba(139, 92, 246, 0.03)');
        nebula.addColorStop(1, 'transparent');
        ctx.fillStyle = nebula;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const nebula2 = ctx.createRadialGradient(canvas.width * 0.8, canvas.height * 0.7, 0, canvas.width * 0.8, canvas.height * 0.7, 250);
        nebula2.addColorStop(0, 'rgba(59, 130, 246, 0.025)');
        nebula2.addColorStop(1, 'transparent');
        ctx.fillStyle = nebula2;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        for (const s of stars) {
            s.alpha += s.delta;
            if (s.alpha <= 0.1 || s.alpha >= 1) s.delta = -s.delta;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fillStyle = s.color;
            ctx.globalAlpha = Math.max(0.1, Math.min(1, s.alpha));
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        maybeShootingStar();
        shootingStars = shootingStars.filter(m => {
            m.x += m.speed; m.y += m.speed * 0.6; m.alpha -= 0.015;
            if (m.alpha <= 0) return false;
            ctx.save();
            ctx.globalAlpha = m.alpha;
            const gradient = ctx.createLinearGradient(m.x, m.y, m.x - m.len, m.y - m.len * 0.6);
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(1, 'transparent');
            ctx.strokeStyle = gradient;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(m.x, m.y);
            ctx.lineTo(m.x - m.len, m.y - m.len * 0.6);
            ctx.stroke();
            ctx.restore();
            return true;
        });

        starAnimId = requestAnimationFrame(draw);
    }
    draw();
}

function stopStarfield() {
    if (starAnimId) { cancelAnimationFrame(starAnimId); starAnimId = null; }
}

function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    if (isDark) {
        html.removeAttribute('data-theme');
        document.getElementById('theme_btn').innerText = '🌙';
        stopStarfield();
        localStorage.setItem('worker_theme', 'light');
    } else {
        html.setAttribute('data-theme', 'dark');
        document.getElementById('theme_btn').innerText = '☀️';
        initStarfield();
        localStorage.setItem('worker_theme', 'dark');
    }
}

function applyTheme() {
    const saved = localStorage.getItem('worker_theme');
    if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.getElementById('theme_btn').innerText = '\u2600\ufe0f';
        initStarfield();
    }
}
applyTheme();

// 应用入口（init 定义于 state.js，在所有 JS 文件拼接后调用）
init();
