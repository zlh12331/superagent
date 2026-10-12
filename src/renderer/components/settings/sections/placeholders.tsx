import type { ReactElement } from 'react';
import { ImChannelsSection } from './im-channels-section';
import { RemoteControlSection } from './remote-control-section';

/** 移动端：局域网远程控制配对 + IM 渠道配置 */
export function MobileSection(): ReactElement {
  return (
    <div className="flex flex-col gap-4 pt-2">
      <RemoteControlSection />
      <ImChannelsSection />
    </div>
  );
}
