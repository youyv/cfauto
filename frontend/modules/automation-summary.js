// Summary uses the last successful server response, never current form inputs.
export function automationSummary(config, templates) {
    if (!config) return { brief: '尚未读取运行状态', details: '读取配置后显示已保存的运行设置。' };
    const interval = Number.isFinite(config.interval) && config.interval > 0 ? config.interval : 30;
    let last = '从未检查';
    if (config.lastCheck !== undefined && config.lastCheck !== null && config.lastCheck !== 0) {
        const date = new Date(config.lastCheck);
        last = typeof config.lastCheck === 'number' && Number.isFinite(date.getTime()) && config.lastCheck > 0
            ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
            : '时间无效';
    }
    const participants = Object.keys(templates).filter(t => config.enabled && config['auto' + t.charAt(0).toUpperCase() + t.slice(1)] !== false).map(t => templates[t].name || t);
    return {
        brief: (config.enabled ? '已启用 · ' + interval + ' 分钟' : '已关闭') + ' · 上次检查：' + last,
        details: '已保存参与项目：' + (participants.join('、') || '无') + '。上次检查不是上次成功部署；实际执行由 Cloudflare Cron 触发，不提供精确倒计时。时间按浏览器本地时区显示。'
    };
}
