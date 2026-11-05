import { TEMPLATES, BINDING } from '../config/templates';
import type { TemplateType } from '../config/templates';
import type { VariableEntry } from './types';
import { mergeVariableBindings } from './deploy-utils';

/**
 * [提取] 把批量部署请求里的 `config: Record<string, string>` 转成变量列表。
 *
 * 供 applyTemplateTransform 使用：部分模板（如 ech）的关键参数是靠改写源码常量
 * 注入的，必须在代码转换阶段拿到值，而不是只写进 bindings。
 */
export function configToVariables(config: Record<string, string> | undefined): VariableEntry[] {
    if (!config || typeof config !== 'object') return [];
    return Object.entries(config)
        .filter(([k, v]) => k && typeof v === 'string' && v.trim() !== '')
        .map(([key, value]) => ({ key, value }));
}

/** [提取] 构建批量部署的 Worker Bindings */
export function buildBatchBindings(
    template: TemplateType, nsId: string, enableKV: boolean,
    savedVars: VariableEntry[] | undefined, config: Record<string, string>
): Array<Record<string, unknown>> {
    let bindings: Array<Record<string, unknown>> = [];
    const t = TEMPLATES[template];

    if (enableKV && nsId && t.kvBindingName) {
        bindings.push({ name: t.kvBindingName, type: BINDING.KV_NAMESPACE, namespace_id: nsId });
    }

    // 无论走 savedVars 还是 config 兜底，都统一交给 mergeVariableBindings 合并：
    // 此前 config 分支直接 push 空字符串绑定，而 mergeVariableBindings 会跳过空值，
    // 导致「批量创建」与「更新部署」对空变量的处理不一致 —— 前者写入空绑定会覆盖掉
    // 上游模板的默认值，后者则保留默认值。统一后两条路径行为一致。
    const vars = batchVariables(template, savedVars, config);

    return mergeVariableBindings(bindings, vars);
}

/** Shared binding selection; source-transform input remains configToVariables(config). */
export function batchVariables(template: TemplateType, savedVars: VariableEntry[] | undefined, config: Record<string, string>): VariableEntry[] {
    return savedVars && savedVars.length > 0 ? savedVars : buildFallbackVars(TEMPLATES[template], config);
}

/**
 * [提取] savedVars 缺失时，用 config + 模板默认值兜底出变量列表。
 *
 * 空值一律用 '' 表示，由 mergeVariableBindings 统一跳过，
 * 从而保证上游模板的默认值仍然生效。
 */
function buildFallbackVars(
    t: (typeof TEMPLATES)[TemplateType], config: Record<string, string>
): VariableEntry[] {
    const vars: VariableEntry[] = [];
    if (config?.ADMIN) vars.push({ key: 'ADMIN', value: config.ADMIN });
    if (t.uuidField && config?.[t.uuidField]) {
        vars.push({ key: t.uuidField, value: config[t.uuidField] });
    }
    t.defaultVars.forEach(key => {
        if (key !== t.kvBindingName && key !== 'ADMIN' && key !== t.uuidField) {
            vars.push({ key, value: config?.[key] ?? '' });
        }
    });
    return vars;
}
