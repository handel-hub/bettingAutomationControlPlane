import { EventEmitter } from 'events';

export class EventBus extends EventEmitter {
  constructor() {
    super();
  }

  emitTransferEvent(type, payload) {
    this.emit(type, payload);
  }
}
