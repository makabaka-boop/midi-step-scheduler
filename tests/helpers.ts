import type { FlushResult, StepMessage, StepperOutput } from '../src/lib/scheduler';

export type SentMidi = {
  status: number;
  data1: number;
  data2: number;
  time?: number;
};

export class CollectingOutput implements StepperOutput {
  messages: StepMessage[] = [];
  flushed: Array<'pause' | 'stop' | 'switch' | 'disconnect'> = [];
  nextReport: FlushResult = { active: [], canceled: [] };
  reports: FlushResult[] = [];

  schedule(message: StepMessage): void {
    this.messages.push(message);
  }

  flush(reason: 'pause' | 'stop' | 'switch' | 'disconnect'): FlushResult {
    this.flushed.push(reason);
    const report = this.nextReport;
    this.reports.push(report);
    this.nextReport = { active: [], canceled: [] };
    return report;
  }
}

export function makeMidiPort(events: SentMidi[]) {
  return {
    send(data: number[], timestamp?: number) {
      events.push({ status: data[0]!, data1: data[1]!, data2: data[2]!, time: timestamp });
    }
  };
}
