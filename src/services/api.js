import axios from 'axios';

// 🟢 localhost ki jagah 127.0.0.1 use kiya (Chrome extensions ke liye safe)
const API = axios.create({ baseURL: 'http://127.0.0.1:5000/api' });

API.interceptors.request.use((req) => {
  const token = localStorage.getItem('token');
  if (token) req.headers.Authorization = `Bearer ${token}`;
  return req;
});

export const registerUser = (data) => API.post('/auth/register', data);
export const loginUser = (data) => API.post('/auth/login', data);
export const getSessions = () => API.get('/sessions');
export const createSession = (data) => API.post('/sessions', data);
// 🆕 Trash + Undo APIs (soft delete = undoable for 30 days)
export const deleteSession = (id) => API.delete(`/sessions/${id}`);        // → trash
export const restoreSession = (id) => API.post(`/sessions/${id}/restore`); // undo single
export const restoreBulkSessions = (ids) => API.post('/sessions/restore/bulk', { ids }); // undo bulk
export const getTrash = () => API.get('/sessions/trash');                  // trashed sessions
export const purgeSession = (id) => API.delete(`/sessions/${id}/purge`);   // forever (no undo)
export const emptyTrash = () => API.delete('/sessions/trash/purge');       // forever (no undo)