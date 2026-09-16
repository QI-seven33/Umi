import asyncio
import uvicorn
from api import app


async def main():
    config = uvicorn.Config(
        app=app,
        host="127.0.0.1",
        port=8000,
    )
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
