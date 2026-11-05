"""Material-only uniform variants. Neutral armor, skin and leather stay exact."""
import colorsys
PALETTES={'ivory':None,'ember':.06,'owls':.61,'gators':.25,'bats':.76,'hornets':.14}
def material_pixel(r,g,b,a):
    h,s,v=colorsys.rgb_to_hsv(r/255,g/255,b/255)
    return bool(a and .43<=h<=.61 and s>=.22 and g>r*1.08 and v>=.26)
def team_variant(im,team):
    out=im.copy()
    if team=='ivory':return out
    hue=PALETTES[team];p=out.load()
    for y in range(out.height):
        for x in range(out.width):
            r,g,b,a=p[x,y]
            if material_pixel(r,g,b,a):
                h,s,v=colorsys.rgb_to_hsv(r/255,g/255,b/255)
                rr,gg,bb=colorsys.hsv_to_rgb(hue,min(.90,max(.78,s*1.25)),min(.98,.18+v*1.15))
                p[x,y]=(round(rr*255),round(gg*255),round(bb*255),a)
    return out
