import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// RTL auto-cleanup requires `globals: true` in Vitest config; wire it explicitly.
afterEach(cleanup);
