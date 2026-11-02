import type { ZoneKind } from '@warehouse-twin/contracts';

export const zoneAppearance: Record<ZoneKind, { name: string; color: string }> = {
  INBOUND: { name: '入库区', color: '#5487ba' }, QC: { name: '质检区', color: '#bd9957' },
  STORAGE: { name: '储存区', color: '#668c80' }, PICKING: { name: '拣货区', color: '#a384bd' },
  OUTBOUND: { name: '出库区', color: '#ce846b' }, CHARGING: { name: '充电位', color: '#7f9a54' },
};
