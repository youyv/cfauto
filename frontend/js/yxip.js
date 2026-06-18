// ===== YXIP 反代落地部署 =====

const REGION_MAP = {'JP':'日本','KR':'韩国','SG':'新加坡','HK':'香港','TW':'台湾','MY':'马来西亚','TH':'泰国','VN':'越南','PH':'菲律宾','ID':'印尼','IN':'印度','AU':'澳大利亚','NZ':'新西兰','GB':'英国','UK':'英国','DE':'德国','FR':'法国','NL':'荷兰','IT':'意大利','ES':'西班牙','US':'美国','CA':'加拿大','BR':'巴西','ZA':'南非','AE':'阿联酋','RU':'俄罗斯','UA':'乌克兰','SE':'瑞典','CH':'瑞士','TR':'土耳其','AR':'阿根廷','CL':'智利','CO':'哥伦比亚','PE':'秘鲁','MX':'墨西哥','PL':'波兰','FI':'芬兰','NO':'挪威','DK':'丹麦','IE':'爱尔兰','BE':'比利时','AT':'奥地利','CZ':'捷克','HU':'匈牙利','RO':'罗马尼亚','GR':'希腊','PT':'葡萄牙'};
function getFlagEmoji(code) { if (code === 'TW') return '🇹🇼'; if (code === 'UK') return '🇬🇧'; if (!code || code.length !== 2) return '🇺🇳'; const codePoints = code.toUpperCase().split('').map(char => 127397 + char.charCodeAt()); return String.fromCodePoint(...codePoints); }

let yxipData = {};
let yxipSelected = [];

async function showYxipModal() {
    document.getElementById('yxip_modal').classList.remove('hidden');
    toggleYxipAccountSelect();
    if (Object.keys(yxipData).length === 0) {
        await fetchYxipRegions();
    }
}

function toggleYxipAccountSelect() {
    const type = document.getElementById('yxip_type').value;
    const accountArea = document.getElementById('yxip_cmliu_account_area');
    const accountList = document.getElementById('yxip_account_list');

    accountArea.classList.remove('hidden');
    const borderCls = type === 'cmliu' ? 'border-red-200' : 'border-blue-200';
    const txtCls = type === 'cmliu' ? 'text-red-500' : 'text-blue-500';
    const bgHoverCls = type === 'cmliu' ? 'hover:bg-red-50' : 'hover:bg-blue-50';
    const badgeBgCls = type === 'cmliu' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600';
    const targetArrName = type === 'cmliu' ? 'workers_cmliu' : 'workers_joey';
    const targetNameStr = type === 'cmliu' ? 'CMLiu' : 'Joey';

    const btnHtml = '<div class="col-span-full flex gap-2 mb-1"><button onclick="document.querySelectorAll(\'input[name=yxip_account]:not([disabled])\').forEach(c=>c.checked=true)" class="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded">全选有效账号</button><button onclick="document.querySelectorAll(\'input[name=yxip_account]\').forEach(c=>c.checked=false)" class="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded">反选所有账号</button></div>';

    accountList.className = 'max-h-[150px] overflow-y-auto border rounded p-3 bg-white grid grid-cols-1 md:grid-cols-2 gap-2 shadow-inner ' + borderCls;
    accountList.innerHTML = btnHtml + accounts.map(a => {
        const targetWorkers = a[targetArrName] || [];
        const noWorker = targetWorkers.length === 0;
        const badge = noWorker ? '<span class="text-[10px] text-gray-400 ml-auto mx-1">无 ' + targetNameStr + ' 项目</span>' : '<span class="' + badgeBgCls + ' px-1.5 py-0.5 rounded text-[10px] ml-auto">' + targetWorkers.length + ' 个项目</span>';
        const opacityClass = noWorker ? 'opacity-50 grayscale' : '';
        const disabledAttr = noWorker ? 'disabled' : '';
        return '<label class="flex items-center gap-2 p-2 border rounded cursor-pointer transition-colors ' + bgHoverCls + ' ' + opacityClass + '">' +
            '<input type="checkbox" name="yxip_account" value="' + a.accountId + '" class="' + txtCls + '" ' + disabledAttr + '>' +
            '<span class="text-xs font-bold text-gray-700 truncate" title="' + a.email + '">' + a.email + '</span>' +
            badge +
        '</label>';
    }).join('');
}

async function fetchYxipRegions() {
    const container = document.getElementById('yxip_regions');
    container.innerHTML = '<div class="col-span-full text-center py-4 text-gray-400">✈️ 正在获取全球节点数据...</div>';
    try {
        const res = await fetch('/api/get_regions_data');
        const data = await res.json();
        if(data.success) {
            yxipData = data.data;
            renderYxipRegions();
        } else {
            container.innerHTML = '<div class="col-span-full text-center py-4 text-red-500">❌ 获取失败: ' + data.msg + '</div>';
        }
    } catch(e) {
        container.innerHTML = '<div class="col-span-full text-center py-4 text-red-500">❌ 网络异常，获取节点数据失败</div>';
    }
}


function doYxipSearch() {
    const input = document.getElementById('yxip_search');
    const q = (input||{}).value||'';
    document.querySelectorAll('#yxip_regions label').forEach(l => {
        if (q === '') { l.style.display = ''; }
        else {
            const text = l.textContent.toLowerCase();
            l.style.display = text.includes(q.toLowerCase()) ? '' : 'none';
        }
    });
}
function clearYxipSearch() {
    const input = document.getElementById('yxip_search');
    if (input) { input.value = ''; input.focus(); doYxipSearch(); }
}
document.addEventListener('keydown', function(e) {
    if (document.activeElement && document.activeElement.id === 'yxip_search') {
        if (e.key === 'Enter') { e.preventDefault(); doYxipSearch(); }
        else if (e.key === 'Escape') { clearYxipSearch(); }
    }
});

function renderYxipRegions() {
    const container = document.getElementById('yxip_regions');
    const codes = Object.keys(yxipData).sort();
    if (codes.length === 0) {
        container.innerHTML = '<div class="col-span-full text-center py-4 text-gray-400">没有找到任何可用节点</div>';
        return;
    }
    container.innerHTML = '<div class="col-span-full flex gap-1 items-center mb-1"><input id="yxip_search" placeholder="🔍 搜索国家/代码..." class="flex-1 text-xs border rounded px-2 py-1"><button id="yxip_search_clear" onclick="clearYxipSearch()" class="text-xs text-gray-400 hover:text-red-500 px-1" title="清除 (Esc)">✕</button><button onclick="doYxipSearch()" class="text-xs bg-blue-500 text-white px-2 py-0.5 rounded">搜索</button></div>' + codes.map(code => {
        const count = yxipData[code].length;
        const cname = REGION_MAP[code] || code;
        return '<label class="flex items-center gap-1.5 p-1.5 border rounded cursor-pointer hover:bg-yellow-50 transition-colors">' +
            '<input type="checkbox" value="' + code + '" onchange="toggleYxipRegion(this)" class="text-yellow-500 accent-yellow-500 rounded">' +
            '<span class="font-bold text-gray-700 text-sm truncate">' + cname + '</span>' +
            '<span class="text-[10px] text-gray-400 ml-auto">' + count + '</span>' +
        '</label>';
    }).join('');
}

function toggleYxipRegion(checkbox) {
    if(checkbox.checked) yxipSelected.push(checkbox.value);
    else yxipSelected = yxipSelected.filter(v => v !== checkbox.value);
}

function yxipSelectAll() {
    document.querySelectorAll('#yxip_regions input[type="checkbox"]').forEach(cb => {
        if(!cb.checked) { cb.checked = true; yxipSelected.push(cb.value); }
    });
}

function yxipSelectNone() {
    document.querySelectorAll('#yxip_regions input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    yxipSelected = [];
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function doYxipDeploy() {
    const type = document.getElementById('yxip_type').value;
    const limit = parseInt(document.getElementById('yxip_limit').value) || 10;

    if (yxipSelected.length === 0) return alert('⚠️ 请至少选择一个区域！');

    let targetAccounts = [];
    const checkedBoxes = Array.from(document.querySelectorAll('input[name="yxip_account"]:checked'));
    if (checkedBoxes.length === 0) {
         return alert(type === 'cmliu' ? '⚠️ 请至少选择一个包含有 CMLiu 项目的目标账号！' : '⚠️ 请至少选择一个包含有 Joey 项目的目标账号！');
    }
    checkedBoxes.forEach(box => {
        const acc = accounts.find(a => a.accountId === box.value);
        if (acc) targetAccounts.push(acc);
    });

    const btnIcon = document.getElementById('yxip_btn_icon');
    btnIcon.innerHTML = '<svg class="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';

    const regionCounters = {};
    const results = [];

    for (const region of yxipSelected) {
        const ipList = shuffleArray([...yxipData[region]]);
        const toTake = Math.min(limit, ipList.length);

        for (let i = 0; i < toTake; i++) {
            const item = ipList[i];
            const code = item.code;
            regionCounters[code] = (regionCounters[code] || 0) + 1;
            const seqNo = regionCounters[code].toString().padStart(2, '0');
            const flag = getFlagEmoji(code);
            const cname = REGION_MAP[code] || code;
            const alias = flag + ' ' + cname + ' ' + seqNo;
            results.push(item.ipPort + '#' + alias);
        }
    }

    const rawContent = type.startsWith('joey') ? results.join(',') : results.join('\n');

    try {
        document.getElementById('yxip_modal').classList.add('hidden');
        openWorkbench();
        wbLog('⚡ 开始进行反代落地部署...', 'text-yellow-400');

        if (type === 'joey_var') {
            const res = await fetch('/api/save_yxip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'joey_var', rawContent })
            });
            const logs = await res.json();
            logs.forEach(l => {
                wbLog(l.msg, l.success ? 'text-green-300' : 'text-red-500');
            });

            wbLog('🔄 开始触发变量专属重加载部署...', 'text-yellow-300');
            try {
                const varsRes = await fetch('/api/settings?type=joey');
                const varsList = await varsRes.json();
                const accIds = targetAccounts.map(a => a.accountId);

                const deployRes = await fetch('/api/deploy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'joey',
                        variables: varsList,
                        deletedVariables: [],
                        targetAccountIds: accIds
                    })
                });
                const deployLogs = await deployRes.json();
                deployLogs.forEach(l => wbLog('[' + (l.success ? '部署OK' : '报错') + '] ' + l.name + ': ' + l.msg, l.success ? 'text-green-300' : 'text-red-400'));
            } catch (e) {
                wbLog('⚠️ 下发变量部署失败: ' + e.message, 'text-red-500');
            }
        } else {
            for (let i = 0; i < targetAccounts.length; i++) {
                const acc = targetAccounts[i];
                wbLog('>> 正在处理账号: ' + acc.alias, 'text-blue-300');
                const res = await fetch('/api/save_yxip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type,
                        accountId: acc.accountId,
                        email: acc.email,
                        globalKey: acc.globalKey,
                        rawContent
                    })
                });
                const logs = await res.json();
                logs.forEach(l => {
                    wbLog(l.msg, l.success ? 'text-green-300' : 'text-red-500');
                });
            }
        }

        wbLog('部署流程结束！', 'text-white font-bold');

        if (type === 'joey') {
            wbLog('⚡ 提示：优选参数已经作为核心配置文件「c」发送到了指定目标账号下的所有 Joey 项目所绑定的 KV 空间。一般下一次访问接口时立即可生效。', 'text-blue-500 font-bold text-xs mt-2');
        } else if (type === 'joey_var') {
            wbLog('⚡ 提示：优选参数已更新并触发了一次目标对应工作台的重加载执行部署。请留意上方控制台的下发动态。', 'text-blue-500 font-bold text-xs mt-2');
        } else if (type === 'cmliu') {
            wbLog('⚡ 提示：CMLiu 优选节点列表已成功注入目标空间的「ADD.txt」。一般下一次访问接口时立即可生效。', 'text-blue-500 font-bold text-xs mt-2');
        }

    } catch (e) {
        alert('请求异常：' + e.message);
    } finally {
        btnIcon.innerHTML = '⚡';
    }
}
