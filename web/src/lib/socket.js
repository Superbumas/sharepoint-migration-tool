import { io } from 'socket.io-client';

// One shared socket for the whole app - Dashboard listens on the implicit
// 'dashboard' room every client auto-joins; JobDetail additionally subscribes
// to 'job:{id}' for that specific job's full event stream.
export const socket = io({ autoConnect: true });
