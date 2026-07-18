export interface RuntimeModelDescriptor {
  id: string;
  name: string;
  providerId: string;
  model: string;
  contextWindow?: number;
  tags?: string[];
}
