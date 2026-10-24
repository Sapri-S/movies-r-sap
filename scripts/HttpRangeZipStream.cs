using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

// Build-time dataset preparation only. No web access is added to the app.
// A bounded cache lets ZipArchive read a public ZIP without saving its whole
// archive, extracting paths, or downloading unneeded research embeddings.
public sealed class HttpRangeZipStream : Stream
{
    private readonly HttpClient client = new HttpClient();
    private readonly Uri originalUri;
    private Uri downloadUri;
    private readonly int blockSize;
    private const int PrefetchCount = 8;
    private byte[] cache = Array.Empty<byte>();
    private long cacheStart = -1;
    private long position;
    private readonly long length;
    private long downloadedBytes;
    private readonly Dictionary<long, Task<byte[]>> pending = new Dictionary<long, Task<byte[]>>();
    public long DownloadedBytes { get { return Interlocked.Read(ref downloadedBytes); } }

    public HttpRangeZipStream(string url, int cacheBytes = 16777216)
    {
        originalUri = new Uri(url);
        if (originalUri.Scheme != "https") throw new ArgumentException("HTTPS is required.");
        if (cacheBytes < 65536 || cacheBytes > 33554432) throw new ArgumentOutOfRangeException(nameof(cacheBytes));
        downloadUri = originalUri;
        blockSize = cacheBytes;
        client.Timeout = TimeSpan.FromSeconds(60);
        using (var request = new HttpRequestMessage(HttpMethod.Get, originalUri))
        {
            request.Headers.Range = new RangeHeaderValue(0, 0);
            using (var response = client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead).GetAwaiter().GetResult())
            {
                CheckResponse(response, 0, 0);
                length = response.Content.Headers.ContentRange.Length ?? 0;
                if (length < 22 || length > 100L * 1024 * 1024 * 1024) throw new IOException("Unexpected ZIP size.");
                downloadUri = response.RequestMessage.RequestUri;
            }
        }
    }

    private static void CheckResponse(HttpResponseMessage response, long start, long end)
    {
        var range = response.Content.Headers.ContentRange;
        if (response.StatusCode != HttpStatusCode.PartialContent || range == null ||
            range.From != start || range.To != end || response.Content.Headers.ContentLength != end - start + 1)
            throw new IOException("The download server did not return the requested bounded ZIP range.");
    }

    private void LoadBlock(long target)
    {
        long start = target / blockSize * blockSize;
        foreach (var old in new List<long>(pending.Keys))
            if (old < start || old >= start + (long)PrefetchCount * blockSize) pending.Remove(old);
        // Bounded range requests overlap network waits. Memory remains bounded
        // at roughly eight cache blocks rather than a full 40 GB ZIP.
        for (int index = 0; index < PrefetchCount; index++)
        {
            long next = start + (long)index * blockSize;
            if (next < length && !pending.ContainsKey(next))
                pending[next] = Task.Run(() => ReadBlock(next));
        }
        try { cache = pending[start].GetAwaiter().GetResult(); cacheStart = start; }
        catch { pending.Remove(start); throw; }
    }

    private byte[] ReadBlock(long start)
    {
        long end = Math.Min(length - 1, start + blockSize - 1);
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                using (var request = new HttpRequestMessage(HttpMethod.Get, downloadUri))
                {
                    request.Headers.Range = new RangeHeaderValue(start, end);
                    using (var response = client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead).GetAwaiter().GetResult())
                    {
                        CheckResponse(response, start, end);
                        using (var stream = response.Content.ReadAsStreamAsync().GetAwaiter().GetResult())
                        using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60)))
                        {
                            var bytes = new byte[checked((int)(end - start + 1))];
                            int read = 0;
                            while (read < bytes.Length)
                            {
                                int amount = stream.ReadAsync(bytes, read, bytes.Length - read, deadline.Token).GetAwaiter().GetResult();
                                if (amount == 0) throw new EndOfStreamException("Interrupted ZIP range.");
                                read += amount;
                            }
                            if (stream.ReadAsync(new byte[1], 0, 1, deadline.Token).GetAwaiter().GetResult() != 0)
                                throw new IOException("Oversized ZIP range.");
                            Interlocked.Add(ref downloadedBytes, read);
                            return bytes;
                        }
                    }
                }
            }
            catch when (attempt < 2) { downloadUri = originalUri; }
        }
        throw new IOException("Could not read ZIP range.");
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (offset < 0 || count < 0 || offset > buffer.Length - count) throw new ArgumentOutOfRangeException();
        if (position >= length || count == 0) return 0;
        if (cacheStart < 0 || position < cacheStart || position >= cacheStart + cache.Length) LoadBlock(position);
        int amount = (int)Math.Min(count, cacheStart + cache.Length - position);
        Buffer.BlockCopy(cache, (int)(position - cacheStart), buffer, offset, amount);
        position += amount;
        return amount;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        long next = checked((origin == SeekOrigin.Begin ? 0 : origin == SeekOrigin.Current ? position : length) + offset);
        if (next < 0 || next > length) throw new IOException("Seek outside ZIP bounds.");
        return position = next;
    }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return length; } }
    public override long Position { get { return position; } set { Seek(value, SeekOrigin.Begin); } }
    public override void Flush() { }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    protected override void Dispose(bool disposing) { if (disposing) client.Dispose(); base.Dispose(disposing); }
}
