import base64,pathlib,sys
src=pathlib.Path(__file__).parent
fonts=pathlib.Path(sys.argv[1])
def face(fam,file,rng=None):
    b=base64.b64encode((fonts/file).read_bytes()).decode()
    return "@font-face{font-family:'%s';src:url(data:font/woff2;base64,%s) format('woff2');font-weight:%s;font-display:swap;%s}"%(fam,b,'400 900' if 'Golos' in fam else '400 700',('unicode-range:%s;'%rng) if rng else '')
css=face('Golos Text','GolosText[wght].woff2')+face('Noto Sans Georgian','NotoSansGeorgian-georgian.woff2','U+10A0-10FF,U+1C90-1CBF,U+2D00-2D2F')+face('Noto Sans Armenian','NotoSansArmenian-armenian.woff2','U+0530-058F,U+FB13-FB17')
head=(src/'01-head.html').read_text().replace('/*FONTS*/',css)
out=head+(src/'02-i18n.js').read_text()+(src/'03-app.js').read_text().replace('</script>','')+(src/'04-screens.js').read_text()+(src/'05-shell.js').read_text()+(src/'06-actions.js').read_text().replace('<script>','')
pathlib.Path(sys.argv[2]).write_text(out)
print(len(out))
