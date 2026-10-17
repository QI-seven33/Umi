import { UmiError } from '../../packages/protocol/src/model.js';

// 进入 ready 的等待也占名额。停止有独立小容量，普通请求不能挤掉它。
export class RequestAdmission {
  private ordinary = 0;
  private control = 0;
  reserve(priority = false): () => void {
    if (priority ? this.control >= 2 : this.ordinary >= 32)
      throw new UmiError('BACKPRESSURE', '待处理请求过多，请稍后从持久游标继续');
    if (priority) this.control++; else this.ordinary++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (priority) this.control--; else this.ordinary--;
    };
  }
}
