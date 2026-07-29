# 📻 tuneup
### overview
made a music streaming app because i my ipod broke and i was so tired of dealing with spotify and apple music. i had a ton of local music on my computer and had wanted to do this for a while because of my spotipi project from forever ago, so i just designed/implemented/deployed it in about a week or so. super fun to make i'm pretty satisfied with it so far.

<img width="972" height="907" alt="image" src="https://github.com/user-attachments/assets/5938c4fa-f7cc-4210-85a7-eddf4502cbde" />


### features
- pwa with mobile first design
- media sessions api = shows nowplaying song on lock screen
- streams mp3 audio from track in bucket
- search function allowing for fuzzy search and keyword
- state persistance, allows for track resume at relevant duration point on reload
- sidebar with track catalog corresponding to r2 folders
- track shuffle (actually shuffles, spotify ur dust) 
- 'up next' queue showing 5 songs playing next
- download button to save tracks to local cache for offline playback
- i drew the icon 😎

  
### tech stack
backend -> flask
frontend -> html/css/js
storage -> cloudflare r2 and sqlite for indexing
deployment env -> railway




