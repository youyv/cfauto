import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
function setup() {
    const events: Record<string, Function> = {};
    let capture = false;
    const handle = { contains: () => true, classList: { add() {}, remove() {} }, setPointerCapture() { capture = true; }, hasPointerCapture: () => capture, releasePointerCapture() { capture = false; } };
    const panel = { style: { left: '200px', top: '80px', transform: 'translateX(-50%)' }, offsetWidth: 700, offsetHeight: 300, getBoundingClientRect() { return { left: parseFloat(this.style.left), top: parseFloat(this.style.top) }; } };
    const win = { innerWidth: 1200, innerHeight: 800, addEventListener: (name: string, fn: Function) => { events[name] = fn; } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../frontend/js/workbench.js'), 'utf8'), {
        $: (id: string) => id === 'workbench_drag' ? handle : panel,
        document: { addEventListener: (name: string, fn: Function) => { events[name] = fn; } },
        window: win, registerActions() {},
    });
    const event = (x: number, y: number, interactive = false, pointerId = 1) => ({ button: 0, isPrimary: true, pointerId, clientX: x, clientY: y, target: { closest: () => interactive ? {} : null }, preventDefault() {} });
    return { events, panel, event, win, captured: () => capture };
}
describe('workbench free dragging', () => {
    it('moves horizontally and vertically without an initial jump', () => {
        const { events, panel, event } = setup();
        events.pointerdown(event(240, 100));
        expect(panel.style.left).toBe('200px');
        expect(panel.style.transform).toBe('none');
        events.pointermove(event(340, 160));
        expect(panel.style.left).toBe('300px'); expect(panel.style.top).toBe('140px');
    });
    it('ignores button descendants and other pointers', () => {
        const { events, panel, event, captured } = setup();
        events.pointerdown(event(240, 100, true)); expect(captured()).toBe(false);
        events.pointerdown(event(240, 100)); events.pointermove(event(400, 400, false, 2));
        expect(panel.style.left).toBe('200px');
    });
    it('clamps the window and stops dragging on cancellation', () => {
        const { events, panel, event, captured } = setup();
        events.pointerdown(event(240, 100)); events.pointermove(event(5000, 5000));
        expect(panel.style.left).toBe('500px'); expect(panel.style.top).toBe('500px');
        events.pointercancel(event(5000, 5000)); expect(captured()).toBe(false);
        events.pointermove(event(0, 0)); expect(panel.style.left).toBe('500px');
    });
    it('keeps a moved panel reachable when the viewport shrinks', () => {
        const { events, panel, event, win } = setup();
        events.pointerdown(event(240, 100)); events.pointerup(event(240, 100));
        win.innerWidth = 800; win.innerHeight = 350; events.resize();
        expect(panel.style.left).toBe('100px'); expect(panel.style.top).toBe('50px');
    });
});
