"""生成本地演示 CA 和服务端证书，需要 openssl 命令。私钥只保存在本机。"""
from pathlib import Path
import argparse, ipaddress, subprocess, os
parser=argparse.ArgumentParser()
parser.add_argument('--ip', action='append', default=[], help='服务端局域网 IPv4，可重复')
args=parser.parse_args()
folder=Path(__file__).resolve().parent/'certs'
folder.mkdir(exist_ok=True)
if (folder/'ca.key').exists():
    raise SystemExit('证书已存在。为避免覆盖已信任的 CA，请先自行备份并移动 certs 文件夹。')
sans=['DNS:localhost','IP:127.0.0.1']+['IP:'+str(ipaddress.ip_address(ip)) for ip in args.ip]
(folder/'server.ext').write_text('subjectAltName='+','.join(sans)+'\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
def run(*args): subprocess.run(['openssl',*args],cwd=folder,check=True)
run('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','30','-subj','/CN=Temporary Chat Demo CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign')
run('req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=localhost')
run('x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out','server.crt','-days','7','-extfile','server.ext')
for name in ('ca.key','server.key'): os.chmod(folder/name,0o600)
print(folder)
