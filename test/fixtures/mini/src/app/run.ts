import { clamp } from '@/utils/math';
import { log } from '../utils/log.js';
import { draw } from '../ui/draw';
export function run() {
  for (let i = 0; i < 3; i++) {
    if (i > 1 && clamp(i) > 0) log('x');
  }
  draw();
}
