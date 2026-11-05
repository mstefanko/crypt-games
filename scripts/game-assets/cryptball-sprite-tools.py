"""Deterministic local atlas extraction helpers shared by sport importers.

Keep extraction arithmetic stable: existing sport atlas bytes are a regression gate.
"""
from PIL import Image

def clean_alpha(im):
    # ImageGen cutouts have alpha250-254 interiors and very faint colored fringes.
    # Never composite the fringe against a matte: discard it before normalization.
    im=im.copy();im.putalpha(im.getchannel('A').point(lambda a:255 if a>=210 else 0))
    return im

def extract_grid(sheet,cols,rows):
    """Assign isolated source silhouettes by center; poses may cross cell lines."""
    width,height=sheet.size;alpha=sheet.getchannel('A').tobytes();seen=bytearray(width*height)
    selected={};components=[]
    for start,value in enumerate(alpha):
        if not value or seen[start]:continue
        stack=[start];seen[start]=1;pixels=[];minx=width;miny=height;maxx=maxy=0
        while stack:
            at=stack.pop();pixels.append(at);x=at%width;y=at//width
            minx=min(minx,x);maxx=max(maxx,x);miny=min(miny,y);maxy=max(maxy,y)
            neighbors=[]
            if x:neighbors.append(at-1)
            if x+1<width:neighbors.append(at+1)
            if y:neighbors.append(at-width)
            if y+1<height:neighbors.append(at+width)
            for nxt in neighbors:
                if alpha[nxt] and not seen[nxt]:seen[nxt]=1;stack.append(nxt)
        if len(pixels)>=64:components.append((pixels,(minx,miny,maxx+1,maxy+1)))
        if len(pixels)<500:continue
        col=min(cols-1,int(((minx+maxx)/2)/width*cols));row=min(rows-1,int(((miny+maxy)/2)/height*rows))
        key=row*cols+col
        if key not in selected or len(pixels)>len(selected[key][0]):selected[key]=(pixels,(minx,miny,maxx+1,maxy+1))
    assert len(selected)==cols*rows,('Expected isolated figures',len(selected),cols*rows)
    # Retain detached solid armor pieces near the owning silhouette. Faint
    # antialias/glow islands are not anatomy and must not become opaque halos.
    main_ids={id(item[0]) for item in selected.values()}
    for extra,box in components:
        if id(extra) in main_ids:continue
        if sum(alpha[at]>=245 for at in extra)/len(extra)<.90:continue
        cx=(box[0]+box[2])/2;cy=(box[1]+box[3])/2
        choices=[]
        for key,(main,bounds) in selected.items():
            dx=max(bounds[0]-box[2],box[0]-bounds[2],0)
            dy=max(bounds[1]-box[3],box[1]-bounds[3],0)
            if dx<=28 and dy<=28:choices.append((dx*dx+dy*dy,key))
        if choices:
            _,key=min(choices);main,bounds=selected[key]
            selected[key]=(main+extra,(min(bounds[0],box[0]),min(bounds[1],box[1]),max(bounds[2],box[2]),max(bounds[3],box[3])))
    result=[]
    for index in range(cols*rows):
        pixels,rect=selected[index];mask=Image.new('L',sheet.size);data=bytearray(width*height)
        for at in pixels:data[at]=255
        mask=Image.frombytes('L',sheet.size,bytes(data)).crop(rect)
        cell=sheet.crop(rect);cell.putalpha(mask)
        result.append((cell,(0,0,cell.width,cell.height),rect))
    return result

def foot_anchor(im):
    box=im.getbbox(); assert box
    y0=max(box[1],box[3]-max(2,round((box[3]-box[1])*.12)))
    pixels=im.load();xs=[x for y in range(y0,box[3]) for x in range(box[0],box[2]) if pixels[x,y][3]]
    return ((min(xs)+max(xs))/2,box[3])


def pack_atlas(assets, output, page_size=1024):
    """Trim without changing pivots, with one transparent pixel between frames."""
    frames={};pages={};page=Image.new('RGBA',(page_size,page_size));x=y=1;row=0;pageid=0
    def savepage():
        page.save(output/f'page-{pageid}.png');pages[str(pageid)]=f'page-{pageid}.png'
    for name,im,pivot,duration in assets:
        box=im.getbbox();assert box,name
        crop=im.crop(box);w,h=crop.size
        assert w+2<=page_size and h+2<=page_size,(name,crop.size)
        if x+w+1>page_size:x=1;y+=row+2;row=0
        if y+h+1>page_size:savepage();pageid+=1;page=Image.new('RGBA',(page_size,page_size));x=y=1;row=0
        page.alpha_composite(crop,(x,y))
        frames[name]={'pageId':str(pageid),'x':x,'y':y,'width':w,'height':h,'originalSize':{'width':im.width,'height':im.height},'trim':{'x':box[0],'y':box[1]},'pivot':{'x':pivot[0],'y':pivot[1]},'duration':duration,'mirrorable':False}
        x+=w+2;row=max(row,h)
    savepage()
    for stale in output.glob('page-*.png'):
        if stale.name not in pages.values():stale.unlink()
    return frames,pages
