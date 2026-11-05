// Compatibility boundary: legacy shared scope supplies explicit module dependencies.
function automationSummary(config) { return frontendModules.automationSummary(config, TEMPLATES); }
function renderAutomationSummary(config) {
    const summary = automationSummary(config);
    const brief = $('auto_runtime_summary'), details = $('auto_runtime_details');
    if (brief && brief.textContent !== summary.brief) brief.textContent = summary.brief;
    if (details && details.textContent !== summary.details) details.textContent = summary.details;
}
