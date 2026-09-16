from datetime import datetime
from dotenv import load_dotenv
import os

load_dotenv(override=True)
llm_base_url = os.getenv("DASHSCOPE_BASE_URL")
llm_api_key = os.getenv("DASHSCOPE_API_KEY")
tavily_api_key = os.getenv("TAVILY_API_KEY")

