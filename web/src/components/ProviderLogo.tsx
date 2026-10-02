import { LOGOS } from '../lib/providerLogos';
import type { ProviderId } from '../lib/signin';

/** A provider's mark, beside the text of its sign-in button. The text names the button, so the mark is hidden from assistive technology. */
export default function ProviderLogo({ provider }: { provider: ProviderId }) {
  const logo = LOGOS[provider];
  return (
    <svg className="signin-logo" data-provider={provider} viewBox={logo.viewBox} width={logo.size} height={logo.size} aria-hidden="true" focusable="false">
      {logo.shapes.map((shape, i) => (
        <path key={i} d={shape.d} fill={shape.fill} />
      ))}
    </svg>
  );
}
