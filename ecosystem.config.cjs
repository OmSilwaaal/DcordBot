// .cjs because package.json is "type": "module" (the original's .js config couldn't load).
module.exports = {
  apps: [
    {
      name: 'meme-signal-discord',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '600M',
      kill_timeout: 8000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
