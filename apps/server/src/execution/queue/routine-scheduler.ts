import type { RoutineScheduler } from "../../domain/routines/service.js";

/**
 * El cron vive en la fila de la rutina. El worker `routine.cron` (cada minuto) llama a RoutineService.tick,
 * así que programar o desprogramar no crea una cola por rutina: el siguiente pase ya ve el cambio.
 */
export class TickRoutineScheduler implements RoutineScheduler {
  async schedule(): Promise<void> {}
  async unschedule(): Promise<void> {}
}
