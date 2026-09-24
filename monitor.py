#!/usr/bin/env python3
import os, json, hashlib, urllib.parse, urllib.request
from datetime import datetime, date, time
from zoneinfo import ZoneInfo

AREAS = [
    {"name": "Evo", "area_id": 337, "product_id": 5},
    {"name": "Vesijako", "area_id": 983, "product_id": 5},
]
HELSINKI = ZoneInfo("Europe/Helsinki")
SEASON_END = date(2026, 11, 11)
LABEL = "eraluvat-watch"

def iso_utc(local_dt):
    return local_dt.astimezone(ZoneInfo("UTC")).isoformat(timespec="milliseconds").replace("+00:00","Z")

def fetch_calendar(area_id, product_id):
    today = datetime.now(HELSINKI).date()
    start_local = datetime.combine(today, time.min, tzinfo=HELSINKI)
    end_local = datetime.combine(SEASON_END, time.min, tzinfo=HELSINKI)
    params = urllib.parse.urlencode({
        "duration":"P1D",
        "from":iso_utc(start_local),
        "to":iso_utc(end_local),
    })
    url = f"https://api.eraluvat.fi/orders/v1/areas/{area_id}/products/{product_id}/calendar?{params}"
    req = urllib.request.Request(url, headers={
        "Accept":"application/json, text/plain, */*",
        "Origin":"https://www.eraluvat.fi",
        "Referer":"https://www.eraluvat.fi/",
        "User-Agent":"eraluvat-watch/1.0",
        "Cache-Control":"no-cache",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def local_date(iso_string):
    dt = datetime.fromisoformat(iso_string.replace("Z","+00:00"))
    return dt.astimezone(HELSINKI).strftime("%-d.%-m.%Y")

def hits_now():
    hits=[]
    for area in AREAS:
        data=fetch_calendar(area["area_id"], area["product_id"])
        for cap in data.get("capacities",[]):
            a=cap.get("available")
            if isinstance(a,(int,float)) and a>0:
                hits.append({
                    "area":area["name"],
                    "date":local_date(cap["from"]),
                    "available":a,
                    "total":cap.get("total"),
                })
    hits.sort(key=lambda x:(x["date"],x["area"]))
    return hits

def gh(method,path,payload=None):
    token=os.environ["GH_TOKEN"]; repo=os.environ["GITHUB_REPOSITORY"]
    data=None
    headers={"Authorization":f"Bearer {token}","Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"eraluvat-watch"}
    if payload is not None:
        data=json.dumps(payload).encode()
        headers["Content-Type"]="application/json"
    req=urllib.request.Request(f"https://api.github.com/repos/{repo}{path}",data=data,headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=20) as r:
        if r.status==204: return None
        return json.load(r)

def ensure_label():
    try:
        gh("POST","/labels",{"name":LABEL,"description":"Eraluvat availability monitor","color":"1f883d"})
    except Exception:
        pass

def open_issue():
    q=urllib.parse.urlencode({"state":"open","labels":LABEL,"per_page":10})
    for issue in gh("GET",f"/issues?{q}"):
        if "pull_request" not in issue: return issue
    return None

def signature(hits):
    s=json.dumps(hits,ensure_ascii=False,sort_keys=True)
    return hashlib.sha256(s.encode()).hexdigest()[:16]

def render(hits):
    owner=os.environ.get("GITHUB_REPOSITORY_OWNER","")
    lines=[(f"@{owner}\n\n" if owner else "")+"Kanalintulupia on nyt vapaana:"]
    for h in hits:
        lines.append(f"- **{h['area']}** — {h['date']}: **{h['available']} kpl vapaana** (kiintiö {h['total']})")
    lines.append("\nTarkista ja varaa heti Eräluvat.fi:stä.")
    return "\n".join(lines)

def main():
    hits=hits_now()
    ensure_label()
    issue=open_issue()
    if hits:
        marker=f"<!-- signature:{signature(hits)} -->"
        text=render(hits)
        body=f"{text}\n\n{marker}"
        if issue is None:
            gh("POST","/issues",{"title":"🚨 Kanalintulupia vapautunut – Evo / Vesijako","body":body,"labels":[LABEL]})
            print("Alert issue created")
        elif marker not in (issue.get("body") or ""):
            gh("POST",f"/issues/{issue['number']}/comments",{"body":text})
            gh("PATCH",f"/issues/{issue['number']}",{"body":body})
            print("Availability changed; issue updated")
        else:
            print("Availability unchanged")
    else:
        if issue is not None:
            gh("POST",f"/issues/{issue['number']}/comments",{"body":"Saatavuus on taas 0 kaikilla tarkistetuilla päivillä. Suljen hälytyksen."})
            gh("PATCH",f"/issues/{issue['number']}",{"state":"closed"})
            print("No availability; previous alert closed")
        else:
            print("No availability")

if __name__=="__main__":
    main()
