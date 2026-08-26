// ===== YXIP 反代落地部署 =====

const REGION_MAP = {'JP':'日本','KR':'韩国','SG':'新加坡','HK':'香港','TW':'台湾','MY':'马来西亚','TH':'泰国','VN':'越南','PH':'菲律宾','ID':'印尼','IN':'印度','AU':'澳大利亚','NZ':'新西兰','GB':'英国','UK':'英国','DE':'德国','FR':'法国','NL':'荷兰','IT':'意大利','ES':'西班牙','US':'美国','CA':'加拿大','BR':'巴西','ZA':'南非','AE':'阿联酋','RU':'俄罗斯','UA':'乌克兰','SE':'瑞典','CH':'瑞士','TR':'土耳其','AR':'阿根廷','CL':'智利','CO':'哥伦比亚','PE':'秘鲁','MX':'墨西哥','PL':'波兰','FI':'芬兰','NO':'挪威','DK':'丹麦','IE':'爱尔兰','BE':'比利时','AT':'奥地利','CZ':'捷克','HU':'匈牙利','RO':'罗马尼亚','GR':'希腊','PT':'葡萄牙'};
function getFlagEmoji(code) {
    if (code === 'TW') return '🇹🇼';
    if (code === 'UK') return '🇬🇧';
    if (!code || code.length !== 2) return '🇺🇳';
    const codePoints = code.toUpperCase().split('').map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
}

/** 特殊策略：写入 joey 全局变量 yx（与后端 YXIP_TARGET_JOEY_VAR 对应） */
const YXIP_TARGET_JOEY_VAR = 'joey_var';

let yxipData = {};
let yxipSelected = [];

/** 校验前置条件后打开 YXIP 弹窗（此前这段逻辑内联在 HTML 的 onclick 里） */
function openYxipGuarded() {
    const hasTarget = state.accounts.some(a =>
        (a.workers_cmliu && a.workers_cmliu.length > 0) || (a.workers_joey && a.workers_joey.length > 0));
    if (!hasTarget) {
        return Swal.fire('无可用目标', '必须先部署至少一个支持的代理项目 (CMLiu 或 Joey) 才能使用反代落地部署功能', 'warning');
    }
    return showYxipModal();
}

async function showYxipModal() {
    openModal('yxip_modal');
    toggleYxipAccountSelect();
    if (Object.keys(yxipData).length === 0) {
        await fetchYxipRegions();
    }
}

/** 当前策略对应的模板类型（joey_var 归属 joey） */
function yxipTemplateOf(type) {
    return type === YXIP_TARGET_JOEY_VAR ? 'joey' : type;
}

function toggleYxipAccountSelect() {
    const type = $('yxip_type').value;
    const tmpl = yxipTemplateOf(type);
    const accountList = $('yxip_account_list');

    $('yxip_cmliu_account_area').classList.remove('hidden');
    const isCmliu = tmpl === 'cmliu';
    const borderCls = isCmliu ? 'border-red-200' : 'border-blue-200';
    const txtCls = isCmliu ? 'text-red-500' : 'text-blue-500';
    const bgHoverCls = isCmliu ? 'hover:bg-red-50' : 'hover:bg-blue-50';
    const badgeBgCls = isCmliu ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600';
    const targetArrName = 'workers_' + tmpl;
    const targetNameStr = isCmliu ? 'CMLiu' : 'Joey';

    accountList.className = 'max-h-[150px] overflow-y-auto border rounded p-3 bg-white grid grid-cols-1 md:grid-cols-2 gap-2 shadow-inner ' + borderCls;
    accountList.innerHTML = '';

    // 全选/反选按钮（DOM API，避免 innerHTML 里嵌内联 onclick）
    const btnRow = document.createElement('div');
    btnRow.className = 'col-span-full flex gap-2 mb-1';
    const selAll = document.createElement('button');
    selAll.className = 'text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded';
    selAll.textContent = '全选有效账号';
    selAll.addEventListener('click', () => {
        document.querySelectorAll('input[name=yxip_account]:not([disabled])').forEach(c => c.checked = true);
    });
    const selNone = document.createElement('button');
    selNone.className = 'text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded';
    selNone.textContent = '反选所有账号';
    selNone.addEventListener('click', () => {
        document.querySelectorAll('input[name=yxip_account]').forEach(c => c.checked = false);
    });
    btnRow.appendChild(selAll); btnRow.appendChild(selNone);
    accountList.appendChild(btnRow);

    state.accounts.forEach(a => {
        const targetWorkers = a[targetArrName] || [];
        const unusable = targetWorkers.length === 0 || !a.globalKey;

        const label = document.createElement('label');
        label.className = 'flex items-center gap-2 p-2 border rounded cursor-pointer transition-colors ' + bgHoverCls + (unusable ? ' opacity-50 grayscale' : '');

        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.name = 'yxip_account'; chk.value = a.accountId;
        chk.className = txtCls;
        chk.disabled = unusable;
        label.appendChild(chk);

        const nameEl = document.createElement('span');
        nameEl.className = 'text-xs font-bold text-gray-700 truncate';
        nameEl.title = a.email || a.alias;
        nameEl.textContent = a.alias + (a.email ? '（' + a.email + '）' : '');
        label.appendChild(nameEl);

        const badge = document.createElement('span');
        if (targetWorkers.length === 0) {
            badge.className = 'text-[10px] text-gray-400 ml-auto mx-1';
            badge.textContent = '无 ' + targetNameStr + ' 项目';
        } else if (!a.globalKey) {
            badge.className = 'text-[10px] text-red-500 ml-auto mx-1';
            badge.textContent = '密钥缺失';
        } else {
            badge.className = badgeBgCls + ' px-1.5 py-0.5 rounded text-[10px] ml-auto';
            badge.textContent = targetWorkers.length + ' 个项目';
        }
        label.appendChild(badge);

        accountList.appendChild(label);
    });
}

async function fetchYxipRegions() {
    const container = $('yxip_regions');
    container.innerHTML = '<div class="col-span-full text-center py-4 text-gray-400">✈️ 正在获取全球节点数据...</div>';
    try {
        const data = await apiFetch('/api/get_regions_data');
        if (data.success) {
            yxipData = data.data || {};
            yxipSelected = [];
            renderYxipRegions();
        } else {
            container.innerHTML = '';
            const err = document.createElement('div');
            err.className = 'col-span-full text-center py-4 text-red-500';
            err.textContent = '❌ 获取失败: ' + (data.msg || '未知错误');
            container.appendChild(err);
        }
    } catch (e) {
        console.error('[fetchYxipRegions]', e);
        container.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'col-span-full text-center py-4 text-red-500';
        err.textContent = '❌ ' + e.message;
        container.appendChild(err);
    }
}

function doYxipSearch() {
    const input = $('yxip_search');
    const q = (input || {}).value || '';
    document.querySelectorAll('#yxip_regions label').forEach(l => {
        if (q === '') { l.style.display = ''; }
        else {
            const text = l.textContent.toLowerCase();
            l.style.display = text.includes(q.toLowerCase()) ? '' : 'none';
        }
    });
}
function clearYxipSearch() {
    const input = $('yxip_search');
    if (input) { input.value = ''; input.focus(); doYxipSearch(); }
}
document.addEventListener('keydown', function (e) {
    if (document.activeElement && document.activeElement.id === 'yxip_search') {
        if (e.key === 'Enter') { e.preventDefault(); doYxipSearch(); }
        else if (e.key === 'Escape') { clearYxipSearch(); }
    }
});

function renderYxipRegions() {
    const container = $('yxip_regions');
    const codes = Object.keys(yxipData).sort();
    container.innerHTML = '';
    if (codes.length === 0) {
        const tip = document.createElement('div');
        tip.className = 'col-span-full text-center py-4 text-gray-400';
        tip.textContent = '没有找到任何可用节点';
        container.appendChild(tip);
        return;
    }

    // 搜索行
    const searchRow = document.createElement('div');
    searchRow.className = 'col-span-full flex gap-1 items-center mb-1';
    const searchInput = document.createElement('input');
    searchInput.id = 'yxip_search';
    searchInput.placeholder = '🔍 搜索国家/代码...';
    searchInput.className = 'flex-1 text-xs border rounded px-2 py-1';
    searchInput.addEventListener('input', doYxipSearch);
    const clearBtn = document.createElement('button');
    clearBtn.className = 'text-xs text-gray-400 hover:text-red-500 px-1';
    clearBtn.title = '清除 (Esc)';
    clearBtn.textContent = '✕';
    clearBtn.addEventListener('click', clearYxipSearch);
    searchRow.appendChild(searchInput); searchRow.appendChild(clearBtn);
    container.appendChild(searchRow);

    codes.forEach(code => {
        const count = yxipData[code].length;
        const cname = REGION_MAP[code] || code;
        const label = document.createElement('label');
        label.className = 'flex items-center gap-1.5 p-1.5 border rounded cursor-pointer hover:bg-yellow-50 transition-colors';

        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.value = code;
        chk.className = 'text-yellow-500 accent-yellow-500 rounded';
        chk.checked = yxipSelected.includes(code);
        chk.addEventListener('change', () => toggleYxipRegion(chk));
        label.appendChild(chk);

        const nameEl = document.createElement('span');
        nameEl.className = 'font-bold text-gray-700 text-sm truncate';
        nameEl.textContent = getFlagEmoji(code) + ' ' + cname;
        label.appendChild(nameEl);

        const cntEl = document.createElement('span');
        cntEl.className = 'text-[10px] text-gray-400 ml-auto';
        cntEl.textContent = String(count);
        label.appendChild(cntEl);

        container.appendChild(label);
    });
}

function toggleYxipRegion(checkbox) {
    if (checkbox.checked) {
        if (!yxipSelected.includes(checkbox.value)) yxipSelected.push(checkbox.value);
    } else {
        yxipSelected = yxipSelected.filter(v => v !== checkbox.value);
    }
}

function yxipSelectAll() {
    document.querySelectorAll('#yxip_regions input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
        if (!yxipSelected.includes(cb.value)) yxipSelected.push(cb.value);
    });
}

function yxipSelectNone() {
    document.querySelectorAll('#yxip_regions input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    yxipSelected = [];
}

/** 加密安全的 Fisher-Yates 洗牌（Math.random 在节点选择上可预测） */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/** 从选中区域按上限抽取节点并生成带别名的列表。纯函数，便于验证 */
function buildYxipList(selectedRegions, pools, limit) {
    const regionCounters = {};
    const results = [];
    for (const region of selectedRegions) {
        const ipList = shuffleArray([...(pools[region] || [])]);
        const toTake = Math.min(limit, ipList.length);
        for (let i = 0; i < toTake; i++) {
            const item = ipList[i];
            const code = item.code;
            regionCounters[code] = (regionCounters[code] || 0) + 1;
            const seqNo = String(regionCounters[code]).padStart(2, '0');
            const alias = getFlagEmoji(code) + ' ' + (REGION_MAP[code] || code) + ' ' + seqNo;
            results.push(item.ipPort + '#' + alias);
        }
    }
    return results;
}

// 部署中标记，防止快速重复点击导致重复下发
let _yxipDeploying = false;

async function doYxipDeploy() {
    if (_yxipDeploying) return Swal.fire('提示', '正在部署中，请稍候', 'info');
    const type = $('yxip_type').value;
    const limitRaw = parseInt($('yxip_limit').value, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 10;

    if (yxipSelected.length === 0) return Swal.fire('提示', '请至少选择一个区域', 'warning');

    const checkedBoxes = Array.from(document.querySelectorAll('input[name="yxip_account"]:checked'));
    if (checkedBoxes.length === 0) {
        const tmpl = yxipTemplateOf(type);
        return Swal.fire('提示', '请至少选择一个包含 ' + (tmpl === 'cmliu' ? 'CMLiu' : 'Joey') + ' 项目的目标账号', 'warning');
    }
    const targetAccounts = checkedBoxes
        .map(box => state.accounts.find(a => a.accountId === box.value))
        .filter(Boolean);
    if (targetAccounts.length === 0) return Swal.fire('提示', '选中的账号已不存在，请刷新页面', 'warning');

    const results = buildYxipList(yxipSelected, yxipData, limit);
    if (results.length === 0) return Swal.fire('提示', '选中区域没有可用节点', 'warning');
    // joey 的 KV 值是逗号分隔的字符串，cmliu 的 ADD.txt 是逐行
    const rawContent = yxipTemplateOf(type) === 'joey' ? results.join(',') : results.join('\n');

    // 通过所有前置校验，正式进入部署流程 → 置锁
    _yxipDeploying = true;
    const btnIcon = $('yxip_btn_icon');
    if (btnIcon) btnIcon.textContent = '⏳';

    try {
        closeModal('yxip_modal');
        openWorkbench();
        wbLog('⚡ 开始进行反代落地部署（' + results.length + ' 个节点）...', 'text-yellow-400');

        if (type === YXIP_TARGET_JOEY_VAR) {
            const logs = await apiFetch('/api/save_yxip', {
                method: 'POST',
                body: JSON.stringify({ type: YXIP_TARGET_JOEY_VAR, rawContent })
            });
            (Array.isArray(logs) ? logs : [{ success: false, msg: '返回格式异常' }])
                .forEach(l => wbLog(l.msg, l.success ? 'text-green-300' : 'text-red-500'));

            wbLog('🔄 开始触发变量专属重加载部署...', 'text-yellow-300');
            try {
                const varsList = await apiFetch('/api/settings?type=joey');
                const accIds = targetAccounts.map(a => a.accountId);
                const deployLogs = await apiFetch('/api/deploy?type=joey', {
                    method: 'POST',
                    body: JSON.stringify({
                        variables: Array.isArray(varsList) ? varsList : [],
                        deletedVariables: [],
                        targetAccountIds: accIds
                    })
                });
                (Array.isArray(deployLogs) ? deployLogs : []).forEach(l =>
                    wbLog('[' + (l.success ? '部署OK' : '报错') + '] ' + l.name + ': ' + l.msg, l.success ? 'text-green-300' : 'text-red-400'));
            } catch (e) {
                wbLog('⚠️ 下发变量部署失败: ' + e.message, 'text-red-500');
            }
        } else {
            for (const acc of targetAccounts) {
                wbLog('>> 正在处理账号: ' + acc.alias, 'text-blue-300');
                try {
                    const deployLogs = await apiFetch('/api/save_yxip', {
                        method: 'POST',
                        body: JSON.stringify({ type, accountId: acc.accountId, rawContent })
                    });
                    (Array.isArray(deployLogs) ? deployLogs : [{ success: false, msg: '返回格式异常' }])
                        .forEach(l => wbLog('   ' + l.msg, l.success ? 'text-green-300' : 'text-red-500'));
                } catch (e) {
                    // 单账号失败不中断其余账号
                    wbLog('   ❌ ' + acc.alias + ': ' + e.message, 'text-red-500');
                }
            }
        }

        wbLog('部署流程结束！', 'text-white font-bold');

        if (type === 'joey') {
            wbLog('⚡ 提示：优选参数已作为核心配置「c」写入目标账号下所有 Joey 项目绑定的 KV 空间，下次访问接口即生效。', 'text-blue-400 font-bold text-xs mt-2');
        } else if (type === YXIP_TARGET_JOEY_VAR) {
            wbLog('⚡ 提示：优选参数已更新为全局变量 yx，并触发了目标账号的重新部署。', 'text-blue-400 font-bold text-xs mt-2');
        } else if (type === 'cmliu') {
            wbLog('⚡ 提示：CMLiu 优选节点列表已注入目标 KV 的「ADD.txt」，下次访问接口即生效。', 'text-blue-400 font-bold text-xs mt-2');
        }
    } catch (e) {
        console.error('[doYxipDeploy]', e);
        wbLog('❌ 请求异常: ' + e.message, 'text-red-500');
        Swal.fire('部署异常', e.message, 'error');
    } finally {
        if (btnIcon) btnIcon.textContent = '⚡';
        _yxipDeploying = false;
    }
}

// @exports
window.buildYxipList = buildYxipList;

registerActions({
    openYxipGuarded: openYxipGuarded,
    showYxipModal: showYxipModal,
    toggleYxipAccountSelect: toggleYxipAccountSelect,
    doYxipSearch: doYxipSearch,
    clearYxipSearch: clearYxipSearch,
    yxipSelectAll: yxipSelectAll,
    yxipSelectNone: yxipSelectNone,
    doYxipDeploy: doYxipDeploy
});
