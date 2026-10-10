/**
 * Formato bruto do agregador fictício. Só os arquivos de src/aggregator/fake
 * e o próprio servidor fictício importam estes tipos.
 */
export interface RawCheckpoint {
  checkpoint_id?: string;
  carrier_status: string;
  message?: string | null;
  location?: string | null;
  checkpoint_time: string;
}

export interface RawTracker {
  id: string;
  tracking_number: string;
  carrier: string;
  checkpoints: RawCheckpoint[];
}

export interface RawTrackerEnvelope {
  tracker: RawTracker;
}
