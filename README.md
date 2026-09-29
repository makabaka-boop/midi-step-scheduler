# 本地 MIDI 步进器

TypeScript + Svelte 实现的本地 1～8 轨、每轨最多 64 个十六分音符步骤的 MIDI 步进器。每一步可编辑音高、力度和门长。音频通过浏览器 Web MIDI 输出；没有 Web MIDI、未授权或没有设备时，乐谱仍可完整编辑，但播放按钮不会进入可播放状态。

## 固定验收

仓库包含一次性 `verify` 服务。按以下顺序执行：

```bash
docker compose config --quiet
docker compose build
docker compose run --rm verify
```

`verify` 会依次运行：

1. `svelte-check` TypeScript/Svelte 类型检查；
2. `vitest run` 调度器、MIDI 适配器、Web MIDI 服务和页面测试；
3. `vite build` 生产构建。

页面测试全部使用假时钟、假 MIDI 服务和虚拟 DOM，不需要真实 MIDI 硬件。

## 本地开发

```bash
npm ci
npm run dev
```

浏览器通常只在 `https://` 或 `http://localhost` 下提供 Web MIDI。打开页面后点击 **Enable MIDI** 授权，再从 **Output** 中选择设备。

其他命令：

```bash
npm test          # 只跑测试
npm run typecheck # 只做类型检查
npm run build     # 生产构建
npm run verify    # 类型检查 + 测试 + 构建
```

可选的 Compose Web 服务放在 `web` profile 中，不会干扰验收：

```bash
docker compose --profile web up web
```

## 功能

- 1～8 轨；每轨 1～64 步。
- 每个启用步骤包含：MIDI 音高 0～127、力度 1～127、门长 1～100%。
- 40～240 BPM；十六分音符步长由 BPM 网格计算。
- 短周期前瞻调度，而不是每个节拍依赖一个恰好准时的定时器。
- 已交给输出适配器的步骤保留其绝对时间戳；修改 BPM 或乐谱只影响尚未送出的步骤。
- 暂停/恢复不会重复播放已经响过的音符，也不会丢失仍未发声的队列。
- 停止会停止定时器、清空待播步骤并发送显式 Note Off。
- 播放中切换输出时，已响音符不重放，仍在队列中的步骤交给新适配器。
- 选中设备热断开时发送显式 Note Off，并尽力发送 All Notes Off（CC 123），然后回到干净的停止状态。
- Web MIDI 不可用或授权失败时仍可编辑，不会假装播放。

## 架构

核心代码位于 `src/lib/`：

- `model.ts`：乐谱数据结构、轨道/步骤数约束和不可变编辑辅助函数。
- `scheduler.ts`：前瞻调度器。它以约 25 ms 的短间隔唤醒，但每次向前规划约 100 ms 的绝对时间音乐事件；定时器晚到只影响本次规划，不承担计时本身。
- `midi-output.ts`：第二级短队列输出适配器。它按 Web MIDI 时间戳发送 Note On/Note Off，并明确区分：
  - 已经发声的步骤（`active`）；
  - 已排队但尚未发声的步骤（`canceled`）；
  - 已经越过边界的休止/完成步骤（`lastPassed`）。
- `midi-service.ts`：Web MIDI 授权、设备枚举、输出选择、热插拔和断开通知。

调度器通过 `StepperClock` 与 `StepperOutput` 接口依赖时钟和输出：

```ts
interface StepperClock {
  now(): number;
  setInterval(callback: () => void, milliseconds: number): { cancel(): void };
}

interface StepperOutput {
  schedule(message: StepMessage): void;
  flush(reason: 'pause' | 'stop' | 'switch' | 'disconnect'): FlushResult;
}
```

因此测试可以用虚拟时钟模拟迟到回调，用收集式输出验证暂停、停止、热插拔、重复点击和停止边界，而无需访问真实 MIDI API。

## 测试覆盖

- `tests/scheduler.test.ts`
  - 绝对时间网格和短周期前瞻；
  - 重复 Play；
  - BPM/乐谱修改只影响未送出的步骤；
  - 暂停后从正确边界恢复；
  - Stop 清理和回到第 0 步；
  - 播放中热切换输出；
  - 输出丢失；
  - 很迟的回调不倾倒旧小节。
- `tests/midi-output.test.ts`
  - 时间戳 Note On/Off；
  - 暂停不重复发音；
  - 休止边界；
  - 断开时 Note Off + All Notes Off；
  - 输出切换报告。
- `tests/midi-service.test.ts`
  - 缺少 Web MIDI；
  - 授权失败；
  - 重复点击共享同一个授权请求；
  - 设备列表和热插拔；
  - 已选设备断开。
- `tests/page.test.ts`
  - 无 MIDI 仍可编辑但不能播放；
  - 授权与输出选择；
  - 重复传输按钮；
  - 热断开后 UI 状态；
  - 音高、力度、门长和结构编辑。

## 说明

Web MIDI 一旦把带有未来时间戳的消息交给平台，通常不能可靠撤回。因此实现只保留很短的第二级输出队列，并在暂停、停止、切换和断开时立即处理仍在发声的音符；这能避免应用层重复发送并尽最大可能释放设备端声音。
