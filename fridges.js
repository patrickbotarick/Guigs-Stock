const nouns={fridge:'Geladeira',shelf:'Prateleira',slot:'Posição'};
const collections={fridge:'fridges',shelf:'shelves',slot:'slots'};
const safeError=e=>typeof e?.message==='string'?e.message:'Não foi possível concluir a solicitação.';
const percent=ratio=>Math.round(Number(ratio)*10000)/100;
export function fridgeSlotState({quantity,min_quantity,target_quantity}){
  const current=Number(quantity);
  return current===0?'VAZIO':current<Number(min_quantity)?'CRÍTICO':current<Number(target_quantity)?'ATENÇÃO':'OK';
}
const physicalOrder=(axis)=>(a,b)=>Number(a[axis])-Number(b[axis])||a.sort_order-b.sort_order||a.id.localeCompare(b.id);

export function createFridgesUI({getContext}){
  const el=id=>document.getElementById(id);
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const owner=()=>getContext().shop?.role==='owner';
  const view=()=>location.hash==='#geladeiras';
  const msg=text=>{el('fridgeMessage').textContent=text;};
  let data=null, editing=false, busy=false, generation=0, pendingRefresh=false;
  let photoUrls=new Map();
  const kind=()=>el('fridgeEditKind').value;
  const selected=()=>data?.[collections[kind()]]?.find(row=>row.id===el('fridgeEditItem').value);
  const option=(value,label)=>{const o=node('option',label);o.value=value;return o;};
  function sync(){
    if(!owner())editing=false;
    const locked=busy||!navigator.onLine;
    el('fridgeEdit').classList.toggle('hidden',!owner());
    el('fridgeEdit').disabled=locked||!data;
    el('fridgeOperate').setAttribute('aria-pressed',String(!editing));
    el('fridgeEdit').setAttribute('aria-pressed',String(editing));
    el('fridgeEditor').classList.toggle('hidden',!editing);
    el('fridgeMap').classList.toggle('hidden',editing);
    el('fridgeOffline').classList.toggle('hidden',navigator.onLine);
    el('fridgeReload').disabled=locked;
    el('fridgeLayoutFields').disabled=locked;
    el('fridgeSaveLayout').disabled=locked||!editing||!data;
    el('fridgeEditKind').disabled=locked;
    el('fridgeEditItem').disabled=locked;
  }
  function field(name,label,settings={}){
    const wrapper=node('div');wrapper.className='field';
    const input=node(settings.options?'select':'input');
    input.id='fridgeField_'+name;input.name=name;
    const caption=node('label',label);caption.htmlFor=input.id;
    if(settings.options)input.replaceChildren(...settings.options.map(([id,text])=>option(id,text)));
    else{
      input.type=settings.type||'text';
      if(settings.maxLength)input.maxLength=settings.maxLength;
      for(const prop of ['min','max','step'])if(settings[prop]!==undefined)input[prop]=settings[prop];
    }
    if(input.type==='checkbox')input.checked=settings.value!==false;
    else input.value=settings.value??'';
    input.required=settings.required===true;
    wrapper.append(caption,input);el('fridgeLayoutFields').append(wrapper);
    return input;
  }
  function renderForm(){
    const fields=el('fridgeLayoutFields');fields.replaceChildren();
    const item=selected(),type=kind();
    if(!data)return;
    field('name','Nome',{value:item?.name,maxLength:120,required:true});
    field('active','Ativa',{type:'checkbox',value:item?.active});
    field('sort_order','Ordem',{type:'number',value:item?.sort_order??0,min:0,max:10000,step:1,required:true});
    if(type==='fridge')field('width_ratio','Largura visual (%)',{type:'number',value:percent(item?.width_ratio??1),min:25,max:100,step:.01,required:true});
    if(type==='shelf'||type==='slot'){
      if(!item){
        const f=field('fridge_id','Geladeira',{options:[['','Selecione'],...data.fridges.map(x=>[x.id,x.name])],required:true});
        if(type==='slot'){
          const h=field('shelf_id','Prateleira',{options:[['','Selecione']],required:true});
          f.addEventListener('change',()=>h.replaceChildren(option('','Selecione'),...data.shelves.filter(x=>x.fridge_id===f.value).map(x=>option(x.id,x.name))));
        }
      }else{
        const f=data.fridges.find(x=>x.id===item.fridge_id), h=data.shelves.find(x=>x.id===item.shelf_id);
        fields.append(node('p',[f?.name,h?.name].filter(Boolean).join(' / ')));
      }
      if(type==='shelf'){
        field('y_ratio','Posição vertical (%)',{type:'number',value:percent(item?.y_ratio??0),min:0,max:95,step:.01,required:true});
        field('height_ratio','Altura relativa (%)',{type:'number',value:percent(item?.height_ratio??1),min:5,max:100,step:.01,required:true});
      }else{
        field('x_ratio','Posição horizontal (%)',{type:'number',value:percent(item?.x_ratio??0),min:0,max:95,step:.01,required:true});
        field('width_ratio','Largura relativa (%)',{type:'number',value:percent(item?.width_ratio??1),min:5,max:100,step:.01,required:true});
        const products=(getContext().products||[]).filter(p=>p.active||p.id===item?.product_id);
        field('product_id','Produto associado',{options:[['','Sem associação'],...products.map(p=>[p.id,p.name+(p.active?'':' (inativo)')])],value:item?.product_id});
        for(const [key,label,value,min] of [['min_quantity','Mínimo',0,0],['target_quantity','Meta',0,0],['capacity_quantity','Capacidade',24,1]]){
          field(key,label,{type:'number',value:item?.[key]??value,min,max:1000000,step:1,required:true});
        }
      }
    }
  }
  function renderEditor(id=''){
    const type=kind();
    const items=data?.[collections[type]]||[];
    const label=item=>{
      const parents=[data.fridges.find(f=>f.id===item.fridge_id)?.name,data.shelves.find(h=>h.id===item.shelf_id)?.name];
      return [...parents.filter(Boolean),item.name+(item.active?'':' (inativa)')].join(' / ');
    };
    el('fridgeEditItem').replaceChildren(option('','Criar: '+nouns[type]),...items.map(item=>option(item.id,label(item))));
    el('fridgeEditItem').value=items.some(i=>i.id===id)?id:'';
    renderForm();
  }
  function renderMap(){
    const map=el('fridgeMap');map.replaceChildren();
    if(!data)return;
    const enabled=data.fridges.filter(f=>f.active);
    if(!enabled.length)map.append(node('p','Nenhuma geladeira ativa. O saldo legado permanece não alocado.'));
    const cabinets=node('div');cabinets.className='fridge-cabinets';
    for(const f of enabled){
      const block=node('section');block.className='fridge-cabinet';
      block.style.setProperty('--cabinet-width',percent(f.width_ratio)*.48+'%');
      const title=node('h3',f.name);title.id='fridge-cabinet-'+f.id;
      block.setAttribute('aria-labelledby',title.id);
      block.append(title,node('p','Ativa'));
      const shelves=data.shelves.filter(h=>h.active&&h.fridge_id===f.id).sort(physicalOrder('y_ratio'));
      if(!shelves.length)block.append(node('p','Sem prateleiras ativas.'));
      for(const h of shelves){
        const shelf=node('section');shelf.className='fridge-shelf';
        const shelfTitle=node('h4',h.name);shelfTitle.id='fridge-shelf-'+h.id;
        shelf.setAttribute('aria-labelledby',shelfTitle.id);
        shelf.append(shelfTitle);
        const rail=node('div');rail.className='fridge-rail';rail.style.setProperty('--shelf-size',String(h.height_ratio));
        const slots=data.slots.filter(x=>x.active&&x.shelf_id===h.id).sort(physicalOrder('x_ratio'));
        if(!slots.length)shelf.append(node('p','Sem posições ativas.'));
        const laneEnds=[];
        for(const x of slots){
          const start=Math.min(100,Math.floor(percent(x.x_ratio))+1);
          const end=Math.max(start+1,Math.min(101,Math.ceil(percent(Number(x.x_ratio)+Number(x.width_ratio)))+1));
          let lane=laneEnds.findIndex(e=>e<=start);
          if(lane<0)lane=laneEnds.length;
          laneEnds[lane]=end;
          const card=node('article');card.className='fridge-slot';card.dataset.slotId=x.id;
          card.style.setProperty('--slot-column',start+' / '+end);card.style.setProperty('--slot-row',String(lane+1));
          const name=node('h5',x.name);name.id='fridge-slot-'+x.id;card.setAttribute('aria-labelledby',name.id);
          const types=[...new Set(x.lots.map(l=>l.product_name))];
          const label=x.product_name||types.join(', ')||'Sem produto associado';
          const image=photoUrls.get(x.image_path||(types.length===1?x.lots[0]?.image_path:null));
          const placeholder=()=>{const n=node('span','▧');n.className='fridge-photo fridge-photo-fallback';n.setAttribute('aria-hidden','true');return n;};
          if(image){const img=node('img');img.className='fridge-photo';img.src=image;img.alt='';img.loading='lazy';img.addEventListener('error',()=>img.replaceWith(placeholder()),{once:true});card.append(img);}
          else card.append(placeholder());
          const state=fridgeSlotState(x),badge=node('span',state);badge.className='fridge-state';badge.dataset.state=state;
          const meter=node('meter');meter.min=0;meter.max=x.capacity_quantity;meter.value=x.quantity;
          meter.setAttribute('aria-label','Ocupação de '+x.name);meter.textContent=x.quantity+' de '+x.capacity_quantity;
          card.append(name,node('p',label+(x.product_active===false?' (inativo)':'')),node('p',x.quantity+' / '+x.capacity_quantity+' un.'),
            meter,badge,node('p','Mínimo '+x.min_quantity+' · Meta '+x.target_quantity));
          if(x.lots.length){
            const lots=node('details');lots.append(node('summary','Lotes e validade'));
            const rows=node('ul');
            for(const l of x.lots)rows.append(node('li',l.code+' · '+l.quantity+' un. · '+l.expiry.split('-').reverse().join('/')));
            lots.append(rows);card.append(lots);
          }
          rail.append(card);
        }
        shelf.append(rail);block.append(shelf);
      }
      cabinets.append(block);
    }
    const unallocated=node('section');unallocated.className='fridge-unallocated';
    unallocated.append(node('h3','Geladeira — não alocado'),node('p',data.unallocated.reduce((sum,l)=>sum+Number(l.quantity),0)+' un. sem posição física'));
    if(data.unallocated.length){
      const list=node('ul');
      for(const l of data.unallocated)list.append(node('li',l.product_name+' · '+l.code+' · '+l.quantity+' un. · '+l.expiry.split('-').reverse().join('/')));
      unallocated.append(list);
    }
    map.append(cabinets,unallocated);
  }
  async function loadPhotos(next,client,stamp){
    const paths=[...new Set(next.slots.flatMap(x=>[x.image_path,...x.lots.map(l=>l.image_path)]).filter(Boolean))];
    if(!paths.length||!client.storage||!client.supabaseUrl)return;
    try{
      const {data:signed}=await client.storage.from('guigs-product-images').createSignedUrls(paths,300);
      if(stamp!==generation||next!==data)return;
      const origin=new URL(client.supabaseUrl).origin;
      for(const entry of signed||[]){
        if(!entry.signedUrl||!paths.includes(entry.path))continue;
        const url=new URL(entry.signedUrl);
        if(url.origin===origin&&url.pathname.startsWith('/storage/v1/object/sign/guigs-product-images/'))photoUrls.set(entry.path,url.href);
      }
      if(photoUrls.size&&!editing)renderMap();
    }catch{/* Sem foto, conservar o placeholder e os dados de estoque. */}
  }
  async function load({keepId=el('fridgeEditItem').value,announce=true}={}){
    const {client,shop}=getContext();
    if(!client||!shop||!navigator.onLine)return;
    if(busy){pendingRefresh=true;return;}
    const stamp=generation;busy=true;sync();if(announce)msg('Consultando mapa…');
    try{
      const {data:next,error}=await client.rpc('guigs_get_fridge_map',{p_shop_id:shop.shop_id});
      if(stamp!==generation)return;
      if(error)throw error;
      if(!next||Object.values(collections).concat('unallocated','dry').some(k=>!Array.isArray(next[k])))throw Error('Mapa indisponível nesta versão do banco.');
      data=next;photoUrls=new Map();renderMap();if(editing)renderEditor(keepId);
      void loadPhotos(next,client,stamp);
      if(announce)msg('');
    }catch(error){if(stamp===generation)msg(safeError(error));}
    finally{
      if(stamp===generation){
        busy=false;sync();
        if(pendingRefresh){pendingRefresh=false;if(view()&&navigator.onLine)void load({announce:false});}
      }
    }
  }
  el('fridgeLayoutForm').addEventListener('submit',async event=>{
    event.preventDefault();if(!owner()||!editing||!data||busy||!navigator.onLine)return;
    const {client,shop}=getContext();const item=selected(),type=kind(),stamp=generation;
    const form=event.currentTarget;
    const values=Object.fromEntries(new FormData(form));
    values.active=form.elements.active.checked;
    if(type==='slot')values.product_id=values.product_id||null;
    for(const key of ['width_ratio','height_ratio','x_ratio','y_ratio'])if(key in values)values[key]=Number(values[key])/100;
    if(!String(values.name||'').trim()){msg('Informe um nome.');return;}
    busy=true;sync();msg('Salvando layout…');
    let saved;
    try{
      const r=await client.rpc('guigs_save_fridge_layout',{p_shop_id:shop.shop_id,p_kind:type,p_values:values,
        p_id:item?.id??null,p_revision:item?.revision??null});
      if(r.error)throw r.error;
      if(!r.data?.id)throw Error('O servidor não confirmou a alteração.');
      saved=r.data;
      if(stamp===generation)msg('Layout salvo. Nenhum saldo foi alterado.');
    }catch(error){if(stamp===generation)msg(safeError(error));}
    finally{if(stamp===generation){busy=false;sync();}}
    if(saved&&stamp===generation)await load({keepId:saved.id,announce:false});
  });
  el('fridgeEditKind').addEventListener('change',()=>renderEditor());
  el('fridgeEditItem').addEventListener('change',renderForm);
  el('fridgeEdit').addEventListener('click',()=>{if(owner()&&navigator.onLine&&data&&!busy){editing=true;renderEditor();sync();}});
  el('fridgeOperate').addEventListener('click',()=>{editing=false;sync();});
  el('fridgeReload').addEventListener('click',()=>void load());
  window.addEventListener('offline',sync);
  window.addEventListener('online',()=>{sync();if(view())void load();});
  return {
    activate(){sync();if(view()&&getContext().shop&&navigator.onLine)void load();},
    reset(){generation++;data=null;photoUrls=new Map();editing=false;busy=false;pendingRefresh=false;el('fridgeLayoutFields').replaceChildren();renderMap();msg('');sync();}
  };
}
