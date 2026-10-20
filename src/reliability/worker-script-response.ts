/** Decode provider multipart source without altering the original journal receipt.
 * The legacy GET-script endpoint can omit filename and return named text parts;
 * content/v2 and older responses can instead return File parts. Metadata strings
 * are not source modules unless the provider explicitly names them as entrypoint. */
export async function readWorkerScriptParts(response: Response): Promise<{name:string;code:string}[]> {
    const form=await response.formData(), entrypoint=response.headers.get('cf-entrypoint');
    const parts:{name:string;code:string}[]=[];
    for(const [name,value] of form) {
        if(typeof value==='string') {
            if(name===entrypoint || /\.(?:c|m)?js$/i.test(name)) parts.push({name,code:value});
        } else parts.push({name:value.name,code:await value.text()});
    }
    return parts;
}
