import React from 'react';
import raw from '../assets/knowall-logo.svg?raw';

// The Knowall wordmark, inlined so the black lettering can follow the text
// colour (it would vanish on the dark theme as a plain <img>). The orange
// cloud and grey strapline keep their own colours.
const WIDTH = 204.702;
const HEIGHT = 34.827;
const markup = raw
  .replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, '')
  .replace(/width="[^"]*"\s+height="[^"]*"/, 'width="100%" height="100%"')
  .replace(/fill="#010101"/g, 'fill="currentColor"');

export default function Logo({ height = 26, className = '' }) {
  return (
    <span
      role="img"
      aria-label="Knowall"
      className={`inline-block shrink-0 text-slate-800 ${className}`}
      style={{ height, width: Math.round((height * WIDTH) / HEIGHT) }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
