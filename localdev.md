### make venv
python -m venv myenv

### start venv
- bash: source .venv/bin/activate
- powershell: .\venv\Scripts\Activate.ps1

### make env file
- add vars

### download requirements
- python install requirements.txt

### adding new songs
- `python -m spotdl download https://open.spotify.com/track/4qdbCACEpbFWIpKSMa2fZC?si=b77226671fc44d9f`
- ` python -m ytdlp https://www.youtube.com/watch?v=Hj9gEUr8S30`


### after adding new songs to cloudflare run library.py
- python library.py
