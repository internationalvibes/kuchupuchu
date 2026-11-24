import React, { useState, useEffect } from 'react';
import { getInitials, safeUrl } from '../utils/sports';

interface TeamLogoProps {
  primary?: string;
  fallback?: string;
  teamName: string;
  size?: 'sm' | 'md' | 'lg';
}

export const TeamLogo: React.FC<TeamLogoProps> = ({
  primary,
  fallback,
  teamName,
  size = 'md',
}) => {
  const primaryUrl = safeUrl(primary);
  const fallbackUrl = safeUrl(fallback);
  const initialSrc = primaryUrl || fallbackUrl;

  const [src, setSrc] = useState<string>(initialSrc);
  const [usedFallback, setUsedFallback] = useState<boolean>(!primaryUrl && Boolean(fallbackUrl));
  const [failed, setFailed] = useState<boolean>(!initialSrc);

  useEffect(() => {
    const nextSrc = primaryUrl || fallbackUrl;
    setSrc(nextSrc);
    setUsedFallback(!primaryUrl && Boolean(fallbackUrl));
    setFailed(!nextSrc);
  }, [primaryUrl, fallbackUrl]);

  const sizeClasses =
    size === 'sm'
      ? 'w-8 h-8 text-xs'
      : size === 'lg'
        ? 'w-14 h-14 text-base'
        : 'w-11 h-11 text-sm';

  const handleError = () => {
    if (!usedFallback && fallbackUrl && fallbackUrl !== src) {
      setUsedFallback(true);
      setSrc(fallbackUrl);
    } else {
      setFailed(true);
    }
  };

  if (failed || !src) {
    return (
      <span
        className={`${sizeClasses} inline-flex shrink-0 items-center justify-center rounded-full bg-[#1b222e] border border-[#2c3648] font-display font-bold tracking-wide text-[#d4dde9] select-none`}
        aria-hidden="true"
      >
        {getInitials(teamName)}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={teamName}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={handleError}
      className={`${sizeClasses} shrink-0 rounded-full object-contain bg-[#131820] border border-[#242b38] p-1`}
    />
  );
};
