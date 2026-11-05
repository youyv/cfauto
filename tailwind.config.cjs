/** Keep v3 syntax compatible with the former runtime CDN; scan dynamic HTML strings too. */
module.exports = {
    content: ['./frontend/index.html', './frontend/js/**/*.js', './src/index.ts'],
    // All current conditional classes use complete literals, not bg- + color concatenation.
    // Keep this list explicit if a future component introduces generated utility names.
    safelist: [],
    theme: { extend: {} },
    plugins: []
};
