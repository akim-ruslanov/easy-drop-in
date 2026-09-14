FROM node:20-alpine

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci

COPY backend ./backend
COPY frontend ./frontend

ARG VITE_API_URL=http://localhost:8787
ENV VITE_API_URL=$VITE_API_URL
RUN cd frontend && npm run build

EXPOSE 8787 5173

CMD ["sh", "-c", "node backend/server.mjs & cd frontend && npm run preview -- --host 0.0.0.0 --port 5173"]
