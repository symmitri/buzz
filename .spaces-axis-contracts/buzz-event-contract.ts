/** Canonical signed native event shape. Type shape alone verifies no signature,
 * source identity, audience or publication outcome. */
export interface BuzzEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface BuzzEventInput {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}
