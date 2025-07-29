import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const extractDateFromUUIDv7 = (uuid: string): Date => {
  const timestampHex = uuid.split("-").join("").slice(0, 12);
  const timestamp = Number.parseInt(timestampHex, 16);
  return new Date(timestamp);
};
